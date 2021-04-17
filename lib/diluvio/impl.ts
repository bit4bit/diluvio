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

export interface PduOptions {
    command: string
    app: string
    arg?: string
}

interface Pdu {
    kind: string
    data:  any
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

type FreeswitchCallbackEvent = (event: any) => void

export class FreeswitchOutboundTCP {
    private conn: any
    private reader: BufReader
    private cb_events: Array<FreeswitchCallbackEvent>
    private text_encoder: TextEncoder
    private text_decoder: TextDecoder
    private alive: boolean = true
    
    constructor(conn: Deno.Reader & Deno.Writer) {
        this.conn = conn
        this.reader = new BufReader(conn)
        this.cb_events = []
        this.text_encoder = new TextEncoder()
        this.text_decoder = new TextDecoder()
    }

    on_event(cb: any) {
        this.cb_events.push(cb)
    }

    async processOne() {
        const pdu = await this.read()
        switch(pdu.kind) {
            case 'event':
                for(const cb of this.cb_events) {
                    cb(pdu.data)
                }
                break
            default:
                throw new Error('not know how handle pdu')
        }
    }
    
    async process() {
        await this.conn.write(this.text_encoder.encode("connect\n\n"))

        while(this.alive) {
            await this.processOne()
        }
    }

    close() {
        this.alive = false
    }
    
    private async read(): Promise<Pdu> {
        const head: any = await this.read_head(this.reader)
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
            default:
                throw new Error(`not implemented ${content_type}`)
        }
    }

    private async read_head(buff: BufReader) {
        const head: any = {}
        
        while (true) {
            const result = await buff.readLine()
            if (result === null)
                break

            const { line, more } = result
            if (more)
                throw new Error('not handle when have more on line')
            
            const sline: string = this.text_decoder.decode(line)

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
    
    private async read_body(head: any): Promise<string | null> {
        const content_length: number = parseInt(head['content-length'])

        if (content_length > 0) {
            console.log(`reading body ${content_length}`)
            const body = new Uint8Array(content_length)
            const n = await this.reader.read(body) ?? 0
            if (content_length != n)
                throw new Error(`mismatch content-length ${content_length} of data readed ${n}`)
            return this.text_decoder.decode(body)
        }

        return null
    }
}
