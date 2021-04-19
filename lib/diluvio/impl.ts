import {
    FreeswitchOutboundConnectioner,
    FreeswitchEvent,
    FreeswitchCommandReply,
    FreeswitchApiReply
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
    text_encoder
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
type FreeswitchConn = Deno.Reader & Deno.Writer

export class FreeswitchOutboundTCP {
    private conn: FreeswitchConn
    private reader: BufReader
    private callback_events: Array<FreeswitchCallbackEvent>
    private alive: boolean = true
    
    constructor(conn: FreeswitchConn) {
        this.conn = conn
        this.reader = new BufReader(conn)
        this.callback_events = []
    }

    on_event(cb: FreeswitchCallbackEvent) {
        this.callback_events.push(cb)
    }

    async iterate() {
        const pdu = await this.read()
        switch(pdu.kind) {
            case 'event':
                for(const cb of this.callback_events) {
                    cb(pdu.data as Head)
                }
                break
            default:
                throw new Error('not know how handle pdu')
        }
    }

    async ack() {
        await this.conn.write(text_encoder.encode("connect\n\n"))
    }
    
    async process() {
        await this.ack()

        while(true) {
            await this.iterate()
        }
    }
    
    private async read(): Promise<Pdu> {
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
            case 'command/reply':
                return {kind: 'command', data: head['reply-text']}
            default:
                throw new Error(`not implemented ${content_type}`)
        }
    }

    private async read_head(buff: BufReader) {
        const head: Head = {}
        
        while (true) {
            const result = await buff.readLine()
            if (result === null)
                break

            const { line, more } = result
            if (more)
                throw new Error('not handle when have more on line')
            
            const sline: string = text_decoder.decode(line)

            if (sline == '')
                break

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
                const body = new Uint8Array(content_length)
                const n = await this.reader.read(body) ?? 0
                if (n == 0)
                    break
                
                partials.push(body)
                if (n < content_length)
                    bytes_to_read = content_length - n
            }

        }

        return partials.map(partial => text_decoder.decode(partial))
            .join('')
    }
}
