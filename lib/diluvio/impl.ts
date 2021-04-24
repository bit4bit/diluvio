import {
    FreeswitchOutboundConnectioner,
    FreeswitchEvent,
    FreeswitchCommandReply,
    FreeswitchApiResponse
} from './mod.ts'

import {
    BufReader,
    Buffer,
    StringReader
} from 'https://deno.land/std@0.93.0/io/mod.ts'

import {
    TextProtoReader
} from 'https://deno.land/std@0.93.0/textproto/mod.ts'

import {
    text_decoder,
    text_encoder,
} from '../deps.ts'


type Head = {[key: string]: string}

export interface PduOptions {
    command: string
    app: string
    arg?: string
}

interface Pdu {
    kind: string
    data: Head | string
}

export class Message {
    static async writeTo(w: Deno.Writer, opts: PduOptions) {
        const pdu = [`sendmsg
call-command: ${opts.command}
execute-app-name: ${opts.app}`]
        if (opts.arg) {
            pdu.push(`execute-app-arg: ${opts.arg}`)
        }
        pdu.push("\n")
        
        const data = new TextEncoder().encode(pdu.join("\n"))
        const n = await w.write(data)
        if (n != data.length)
            throw new Error('mismatch data length')
    }
}

type FreeswitchCallbackEvent = (event: FreeswitchEvent) => void
type FreeswitchCallbackCommand = (reply: string) => void
type FreeswitchConn = Deno.Reader & Deno.Writer

export enum FreeswitchCallbackType {
    Event = 'event',
    CommandReply = 'command/reply',
    ApiResponse = 'api/response',
    AuthResponse = 'auth/response'
}

export class FreeswitchProtocolParser {
    private reader: BufReader

    constructor(reader: BufReader) {
        this.reader = reader
    }

    async read(): Promise<Pdu> {
        const head: Head = await this.read_head(this.reader)
        const body: string | null = await this.read_body(head)

        const content_type = head['content-type']

        switch(content_type) {
            case 'text/event-plain':
                if (body) {
                    const buff = new BufReader(new StringReader(body))
                    const header = await this.read_head(buff)
                    return {kind: 'event', data: header}
                } else {
                    return {kind: 'event', data: {}}
                }
            case 'api/response':
                return {kind: 'api', data: body ?? ''}
            case 'command/reply':
                return {kind: 'command', data: head['reply-text']}
            case 'auth/request':
                return {kind: 'auth/response', data: body ?? ''}
            case 'text/disconnect-notice':
                return {kind: 'api', data: 'disconnect'}
            default:
                return {kind: 'omit', data: ''}
        }
    }

    private async read_head(buff: BufReader) {
        const head: Head = {}
        
        while (true) {
            const result = await buff.readLine()

            if (result === null) {
                break
            }
            const { line, more } = result
            if (more)
                throw new Error('not handle when have more on line')

            const sline: string = text_decoder.decode(line)

            if (sline == '') {
                break
            }

            const [key, value] = sline.split(':')
            head[key.toLowerCase()] = value.trim()

            const peek = await buff.peek(1)
            if (peek !== null && peek[0] == 10) {
                const eol = new Uint8Array(1)
                await buff.read(eol)
                break
            }
        }

        return head
    }
    
    private async read_body(head: Head): Promise<string | null> {
        const content_length: number = parseInt(head['content-length'])
        const partials: Array<Uint8Array> = []
        
        if (content_length > 0) {
            let bytes_to_read = content_length


            while(bytes_to_read > 0) {
                const body = new Uint8Array(bytes_to_read)
                const n = await this.reader.read(body) ?? 0
                if (n == 0)
                    break

                partials.push(body)
                if (n < content_length)
                    bytes_to_read = content_length - n
                else
                    break
            }

        }

        return partials.map(partial => text_decoder.decode(partial))
            .join('')
    }
}

abstract class FreeswitchConnectionTCP  {
    protected conn: FreeswitchConn
    protected reader: BufReader
    private callbacks: {[key: string]: Array<FreeswitchCallbackEvent>}
    private callbacks_once: {[key: string]: Array<FreeswitchCallbackEvent | FreeswitchCallbackCommand>}
    private alive: boolean = true
    private parser: FreeswitchProtocolParser
    
    protected abstract before_process(): Promise<void>
    
    constructor(conn: FreeswitchConn) {
        this.conn = conn
        this.reader = new BufReader(conn)
        this.parser = new FreeswitchProtocolParser(this.reader)
        this.callbacks = {}
        this.callbacks_once = {}
    }

    async execute(cmd: string, arg: string): Promise<FreeswitchCommandReply> {
        const reply = await this.sendmsg('execute', cmd, arg)
        return reply.reply
    }

    async api(cmd: string, arg: string) {
        this.sendcmd(`api ${cmd} ${arg}`)

        const wait_reply: Promise<string> = new Promise((resolve) => {
            this.once(FreeswitchCallbackType.ApiResponse, (reply: string) => {
                resolve(reply)
            })
        })       


        return await wait_reply
    }
    
    on(event: FreeswitchCallbackType, cb: FreeswitchCallbackEvent) {
        if (!this.callbacks[event]) this.callbacks[event] = []
        
        this.callbacks[event].push(cb)
    }

    once(event: FreeswitchCallbackType, cb: FreeswitchCallbackEvent | FreeswitchCallbackCommand) {
        if (!this.callbacks_once[event]) this.callbacks_once[event] = []
        this.callbacks_once[event].push(cb)
    }
    
    
    async iterate() {
        const pdu = await this.parser.read()

        switch(pdu.kind) {
            case 'event':
                let callbacks = this.callbacks[FreeswitchCallbackType.Event] || []
                for(const cb of callbacks) {
                    cb(pdu.data as Head)
                }
                break
            case 'command':
                this.run_callbacks_once_for(FreeswitchCallbackType.CommandReply, pdu.data as string)
                break
            case 'api':
                this.run_callbacks_once_for(FreeswitchCallbackType.ApiResponse, pdu.data as string)
                break
            case 'auth/response':
                this.run_callbacks_once_for(FreeswitchCallbackType.AuthResponse, pdu.data as string)
                break
            case 'omit':
                break
            default:
                throw new Error('not know how handle pdu')
        }
    }

    
    async process() {
        await this.before_process()
        
        while(true) {
            await this.iterate()
        }
    }

    protected async sendcmd(cmd: string) {
        await this.conn.write(text_encoder.encode(cmd + "\n\n"))
    }

    protected async sendmsg(cmd: string, app: string, arg?: string) {
        Message.writeTo(this.conn, {
            command: cmd,
            app: app,
            arg: arg
        })
        const reply: string = await new Promise((resolve) => {
            this.once(FreeswitchCallbackType.CommandReply, (reply: string) => {
                resolve(reply)
            })
        })

        if (reply.startsWith('-ERR')) {
            return {ok: false, reply: reply}
        } else {
            return {ok: true, reply: reply}
        }
    }

    private run_callbacks_once_for(event: FreeswitchCallbackType, data: string): void {
        const callbacks = Array.from(this.callbacks_once[event] || [])
        this.callbacks_once[event].length = 0
        
        for (const cb of callbacks) {
            const cbc = cb as FreeswitchCallbackCommand;
            cbc(data)
        }
        
    }
}

export class FreeswitchOutboundTCP extends FreeswitchConnectionTCP {
    protected async before_process() {
        this.ack()
    }

    async ack() {
        await this.conn.write(text_encoder.encode("connect\n\n"))
    }
}

export class FreeswitchInboundTCP extends FreeswitchConnectionTCP {
    protected async before_process() {
    }

    async auth(pass: string) {

        const wait_auth_reply: Promise<string> = new Promise((resolve) => {
            this.once(FreeswitchCallbackType.CommandReply, (reply: string) => {
                resolve(reply)
            })
        })

        await new Promise((resolve) => {
            this.once(FreeswitchCallbackType.AuthResponse, (reply: string) => {
                this.sendcmd(`auth ${pass}`)
                resolve(reply)
            })
        })       

        return await wait_auth_reply
    }

}
