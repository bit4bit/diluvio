import {
    FreeswitchOutboundConnectioner,
    FreeswitchEvent,
    FreeswitchCommandReply,
    FreeswitchApiResponse,
    FreeswitchEventCallback,
    DialplanFetcher,
    DialplanActioner,
    DialplanActionerParameter,
    DialplanActionerAction,
    Publisher
} from './mod.ts'

import {
    BufReader,
    Buffer,
    StringReader,
    text_decoder,
    text_encoder,
} from '../deps.ts'


type Head = {[key: string]: string}

export interface PduCommand{
    command: string
    app: string
    arg?: string
    lock: boolean
}

interface Pdu {
    kind: string
    data: Head | string
}

export class Message {
    static async writeTo(w: Deno.Writer, opts: PduCommand) {
        const pdu = [`sendmsg
call-command: ${opts.command}
execute-app-name: ${opts.app}`]
        if (opts.arg) {
            pdu.push(`execute-app-arg: ${opts.arg}`)
        }
        pdu.push(`event-lock: ${opts.lock}`)
        pdu.push("\n")
        
        const data = text_encoder.encode(pdu.join("\n"))
        const n = await w.write(data)
        if (n != data.length)
            throw new Error('mismatch data length')
    }
}

type FreeswitchCallbackEvent = (event: FreeswitchEvent) => void
type FreeswitchCallbackCommand = (reply: string | Head) => void
type FreeswitchConn = Deno.Reader & Deno.Writer

export enum FreeswitchCallbackType {
    Event = 'event',
    CommandReply = 'command/reply',
    ApiResponse = 'api/response',
    AuthRequest = 'auth/request',
    Disconnect = 'disconnect'
}


export class FreeswitchConnectionError extends Error {
}

export class FreeswitchConnectionClosed extends Error {
}

export class FreeswitchProtocolParser {
    private reader: BufReader

    constructor(reader: BufReader) {
        this.reader = reader
    }

    async read(): Promise<Pdu> {
        while(true) {
            const head: Head = await this.read_head(this.reader)
            const body: string | null = await this.read_body(head)

            const content_type = head['content-type']

            switch(content_type) {
                case 'text/event-json':
                    if (body === null)
                        throw new Error('failed to get body for event json')
                    
                    const event = JSON.parse(body)
                    return {kind: 'event', data: this.normalize_event(event)}
                case 'text/event-plain':
                    if (body === null)
                        throw new Error('failed to get body for event json')

                    const buff = new BufReader(new StringReader(body))
                    const header = await this.read_head(buff)
                    return {kind: 'event', data: this.normalize_event(header)}
                case 'api/response':
                    return {kind: 'api', data: body ?? ''}
                case 'command/reply':
                    return {kind: 'command', data: head}
                case 'auth/request':
                    return {kind: 'auth/request', data: body ?? ''}
                case 'text/disconnect-notice':
                    return {kind: 'disconnect', data: body ?? ''}
                default:
                        console.warn('protocol parser: unknown content_type')
                        continue
            }
        }
    }

    private async read_head(buff: BufReader) {
        const head: Head = {}
        
        while (true) {
            const result = await buff.readLine()

            if (result === null) {
                throw new FreeswitchConnectionError()
                
            }
            const { line, more } = result
            if (more)
                continue

            const sline: string = text_decoder.decode(line)

            if (sline == '') {
                throw new Error('not know how to handle sline == ""')
            }

            const [key, value] = sline.split(':')
            if (value === undefined)
                continue
            
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
                if (n < bytes_to_read)
                    bytes_to_read = content_length - n
                else
                    break
            }

        }

        return partials.map(partial => text_decoder.decode(partial))
            .join('')
    }

    private normalize_event(event: any): any {
        const new_event: any = {}

        for(const [key, value] of Object.entries(event)) {
            new_event[key.toLowerCase()] = (value + '').trim()
        }

        return new_event
    }
}

/**
 * Base implementation freeswitch event socket
 */
abstract class FreeswitchConnectionTCP  {
    protected conn: FreeswitchConn
    protected reader: BufReader
    private queue_events: Array<FreeswitchEvent> = []
    private callbacks: {[key: string]: Array<FreeswitchCallbackEvent>}
    private callbacks_once: {[key: string]: Array<FreeswitchCallbackCommand>}
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

    // TODO(bit4bit) on outbound socket required `async full`
    async api(cmd: string, arg: string) {
        this.sendcmd(`api ${cmd} ${arg}`)
        return await this.wait_reply(FreeswitchCallbackType.ApiResponse)
    }

    async set_variable(name: string, value: string) {
        await this.sendmsg('execute', 'set', `${name}=${value}`)
    }
    
    async event(kind: string, events: Array<string>): Promise<string> {
        this.sendcmd(`event ${kind} ${events.join(",")}`)
        return await this.wait_reply(FreeswitchCallbackType.CommandReply)
    }
    
    on(event: FreeswitchCallbackType, cb: FreeswitchCallbackEvent) {
        if (!this.callbacks[event]) this.callbacks[event] = []
        
        this.callbacks[event].push(cb)
    }

    once(event: FreeswitchCallbackType, cb: FreeswitchCallbackCommand) {
        if (!this.callbacks_once[event]) this.callbacks_once[event] = []
        
        this.callbacks_once[event].push(cb)
    }


    private iterate_events() {
        const event = this.queue_events.shift()
        
        if (event === undefined) return
        
        let callbacks = this.callbacks[FreeswitchCallbackType.Event] || []
        for(const cb of callbacks) {
            cb(event)
        }
    }
    
    async iterate() {
        const pdu = await this.parser.read()
        switch(pdu.kind) {
            case 'event':
                this.dispatch_event(pdu.data as Head)
                break
            case 'command':
                this.run_callbacks_once_for(FreeswitchCallbackType.CommandReply, pdu.data)
                break
            case 'api':
                this.run_callbacks_once_for(FreeswitchCallbackType.ApiResponse, pdu.data as string)
                break
            case 'auth/request':
                this.run_callbacks_once_for(FreeswitchCallbackType.AuthRequest, pdu.data as string)
                break
            case 'disconnect':
                this.run_callbacks_once_for(FreeswitchCallbackType.Disconnect, pdu.data as string)
                throw new FreeswitchConnectionClosed()
                break
            default:
                throw new Error(`not know how handle pdu`)
        }


        this.iterate_events()
    }

    
    async process() {
        await this.before_process()
        
        while(true) {
            try {
                await this.iterate()
            } catch (error) {
                if (error instanceof FreeswitchConnectionError)
                    return

                if (error instanceof FreeswitchConnectionClosed)
                    return
                
                throw error
            }
        }
    }

    protected async sendcmd(cmd: string) {
        await this.conn.write(text_encoder.encode(cmd + "\n\n"))
    }

    protected async sendmsg(cmd: string, app: string, arg?: string, lock: boolean = true) {
        Message.writeTo(this.conn, {
            command: cmd,
            app: app,
            arg: arg,
            lock: lock
        })

        const reply: string = await this.wait_reply(FreeswitchCallbackType.CommandReply)

        if (reply.startsWith('-ERR')) {
            return {ok: false, reply: reply}
        } else {
            return {ok: true, reply: reply}
        }
    }

    private run_callbacks_once_for(event: FreeswitchCallbackType, data: string | Head): void {
        if (!this.callbacks_once[event])
            return
        
        const callbacks = Array.from(this.callbacks_once[event] || [])
        this.callbacks_once[event].length = 0
        
        for (const cb of callbacks) {
            const cbc = cb as FreeswitchCallbackCommand;
            cbc(data)
        }
    }

    protected wait_reply(kind: FreeswitchCallbackType): Promise<string> {
        return new Promise((resolve) => {
            this.once(kind, (reply: string | Head) => {
                if (typeof reply == 'object')
                    resolve(reply['reply-text'])
                else
                    resolve(reply)
            })
        })
    }

    protected wait_reply_data(kind: FreeswitchCallbackType): Promise<Head> {
        return new Promise((resolve) => {
            this.once(kind, (reply: string | Head) => {
                resolve(reply as Head)
            })
        })
    }

    protected dispatch_event(data: Head) {
        this.queue_events.push(data)
    }
}

/**
 * See https://freeswitch.org/confluence/display/FREESWITCH/Event+Socket+Outbound
 */
export class FreeswitchOutboundTCP extends FreeswitchConnectionTCP implements FreeswitchOutboundConnectioner {
    
    async hangup(reason: string): Promise<void> {
        await this.sendmsg('execute', 'hangup', reason)
    }

    on_hangup(cb: FreeswitchEventCallback): void {
        this.on(FreeswitchCallbackType.Event, (event: FreeswitchEvent) => {
            if (event['event-name'] == 'CHANNEL_HANGUP_COMPLETE') {
                cb(event)
            }
        })
    }

    on_event(cb: FreeswitchEventCallback): void {
        this.on(FreeswitchCallbackType.Event, (event: FreeswitchEvent) => {
            cb(event)
        })
    }

    protected async before_process() {
        // outbound socket need ack connection from freeswitch
        await this.ack()
        this.iterate()

        // channel data it's send to customer
        const channel_data = await this.wait_reply_data(FreeswitchCallbackType.CommandReply)
        await this.sendcmd('myevents')
        
        this.iterate()
        await this.wait_reply(FreeswitchCallbackType.CommandReply)

        // enqueue channel data as event
        this.dispatch_event(channel_data)
    }

    async ack() {
        await this.conn.write(text_encoder.encode("connect\n\n"))
    }
}


/**
 * See https://freeswitch.org/confluence/display/FREESWITCH/mod_event_socket
 */
export class FreeswitchInboundTCP extends FreeswitchConnectionTCP {
    protected async before_process() {
    }

    async auth(pass: string) {
        await this.wait_reply(FreeswitchCallbackType.AuthRequest)
        this.sendcmd(`auth ${pass}`)

        return await this.wait_reply(FreeswitchCallbackType.CommandReply)
    }

}


/**
 *Implementation using HTTP for get dialplan
 */
export class DialplanHTTP implements DialplanFetcher {
    private base: string
    private headers: any
    
    constructor(base: string, headers: any = {}) {
        this.base = base
        this.headers = headers
    }
    
    async fetch(url: string, data?: any): Promise<Array<DialplanActioner> | []> {
        let headers = { ...this.headers }
        Object.assign(headers, this.headers, {'accept': 'application/json'})

        const response = await fetch(this.base + url, {
            method: 'PUT',
            cache: 'no-cache',
            headers: headers,
            body: JSON.stringify(data)
        })
        const body = await response.json()
        return body
    }
}

/**
 * Implementation using HTTP for publishing events
 */
export class PublishHTTP implements Publisher {
    private base: string
    private headers: any
    
    constructor(base: string, headers: any = {}) {
        this.base = base
        this.headers = headers
    }
    
    async event(destination: string, event: FreeswitchEvent) {
        let headers = { ...this.headers }
        Object.assign(headers, this.headers, {'content-type': 'application/json'})
        
        await fetch(this.base + destination, {
            method: 'POST',
            cache: 'no-cache',
            headers: headers,
            redirect: 'follow',
            body: JSON.stringify(event)
        })
    }
}
