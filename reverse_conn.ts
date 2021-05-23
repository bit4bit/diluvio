import { FreeswitchOutboundTCP, DialplanHTTP, PublishHTTP } from './lib/diluvio/impl.ts'
import { FreeswitchEvent, Diluvio, DialplanActioner } from './lib/diluvio/mod.ts'

import { text_decoder } from './lib/deps.ts'

import { serve, ServerRequest } from "https://deno.land/std@0.95.0/http/server.ts";

interface HookEvent {
    filter: (event: FreeswitchEvent) => boolean
    callback: (event: FreeswitchEvent) => void
}

// reverse connection
class Connection {
    private event_hooks: Array<HookEvent> = []
    private actions: Array<DialplanActioner> = []
    private action_replies: Map<string, any> = new Map()
    
    private id: string
    private _action_id: number = 0
    
    constructor(id: string) {
        this.id = id
    }
    
    async handle(req: ServerRequest) {
        const url = this.get_URL(req)
        console.log(url.pathname)
        switch(url.pathname) {
            case '/reply':
                this.process_actions(req)
                break
            case '/event':
                const body_event = await Deno.readAll(req.body)
                const event = JSON.parse(text_decoder.decode(body_event))

                if (event['event-name'] == 'CHANNEL_EXECUTE') {
                    console.log('channel-execute: ' + event['application'])
                }
                if (event['event-name'] == 'CHANNEL_EXECUTE_COMPLETE') {
                    console.log('channel-execute-complete: ' + event['application'])
                }
                this.hook_event(event)
                break
        }
    }

    
    async action_wait_execute(cmd: string, arg: string) {
        const action_id = this.next_action_id() + ''
        const reply = `/reply?diluvio_action_id=${action_id}&diluvio_request_id=${this.id}`
        const action = {action: cmd, data: arg, event_uuid: action_id, reply: reply}

        const replie =  new Promise((resolve) => {
            this.action_replies.set(action_id, resolve)
        })

        
        const resp = new Promise((resolve) => {
            this.on_event({
                filter: (event) => {
                    return event['event-name'] == 'CHANNEL_EXECUTE_COMPLETE' && event['application-uuid'] == action_id
                },
                callback: resolve
            })
        })

        this.actions.push(action)

        const reply_val = await replie
        console.log(`action get reply ${reply_val} for ${action_id}`)
        return await resp
    }

    async action(cmd: string, arg: string) {
        const action_id = this.next_action_id() + ''
        const reply = `/reply?diluvio_action_id=${action_id}&diluvio_request_id=${this.id}`
        const action = {action: cmd, data: arg, reply: reply}

        this.actions.push(action)
        
        return await new Promise((resolve) => {
            this.action_replies.set(action_id, resolve)
        })
    }

    async api(cmd: string, arg: string) {
        const action_id = this.next_action_id() + ''
        const reply = `/reply?diluvio_action_id=${action_id}&diluvio_request_id=${this.id}`
        const action = {api: cmd, arg: arg, reply: reply}

        this.actions.push(action)
        
        return await new Promise((resolve) => {
            this.action_replies.set(action_id, resolve)
        })
    }

    on_event(hook: HookEvent) {
        this.event_hooks.push(hook)
    }

    private next_action_id(): number {
        return this._action_id += 1
    }

    private get_URL(req: ServerRequest): URL {
        const path = `http://localhost${req.url}`
        return new URL(path)
    }
    
    private async process_actions(req: ServerRequest) {
        const url = this.get_URL(req)
        const action_id = url.searchParams.get('diluvio_action_id') ?? ''

        console.log('cheking for action reply ' + action_id)
        // notify reply
        if (this.action_replies.get(action_id)) {
            const body = await Deno.readAll(req.body)
            console.log('calling reply for ' + action_id)
            this.action_replies.get(action_id)(text_decoder.decode(body))
            this.action_replies.delete(action_id)
        }
        
        if (this.actions.length == 0) {
            console.log('no actions waiting')
            setTimeout(async () => {
                await this.process_actions(req)
            }, 1000)
            return
        }

        this.send_reply(req, this.actions)
        this.actions = []
    }

    private hook_event(event: FreeswitchEvent) {
        for(const hook of this.event_hooks) {
            if (hook.filter(event)) {
                hook.callback(event)
            }
        }
    }

    private send_reply(req: ServerRequest, data: any) {
        console.log(`\t send reply : ${JSON.stringify(data)}`)
        req.respond({body: JSON.stringify(data)})
    }
}


// run a lineal plan
async function plan(connection: Connection) {
    console.log('running plan')
    //console.log(await connection.action_wait_execute('answer', ''))
    console.log('#step 1')
    await connection.action_wait_execute('sleep', '1000')
    await connection.action_wait_execute('playback', 'tone_stream://L=3;%(100,100,350,440)')
    console.log('#step 2')
    await connection.action_wait_execute('playback', 'tone_stream://L=4;%(100,100,350,440)')
    console.log('#step 3')
    await connection.action_wait_execute('playback', 'tone_stream://L=5;%(100,100,350,440)')
    await connection.action('hangup', 'OUT')
}

async function httpi(port: number) {
    const conn = new Connection('123')
    const server = serve({port: port})

    
    for await (const req of server) {
        console.log('main: ' + req.url)
        if (req.url == '/') {
            plan(conn)
            req.url = '/reply'
        }
        conn.handle(req)
    }
}

httpi(48000)


// freeswitch outbound handler
const dialplan = new DialplanHTTP('http://localhost:48000')
const publish = new PublishHTTP('http://localhost:48000/event')

const listener = Deno.listen({port: 44002})
console.log('listening tcp')

for await (const conn of listener) {
    const diluvio = new Diluvio(dialplan, publish)
    const fsconn = new FreeswitchOutboundTCP(conn)        
    const diluvio_conn = diluvio.connect(fsconn)
    
    fsconn.process()
    await diluvio_conn.process()
    console.log('done connection to freeswitch')
}
