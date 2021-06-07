import { FreeswitchOutboundTCP, DialplanHTTP, PublishHTTP } from './lib/diluvio/impl.ts'
import { FreeswitchEvent, Diluvio, DialplanActioner } from './lib/diluvio/mod.ts'

import { text_decoder } from './lib/deps.ts'

import { serve, ServerRequest } from "https://deno.land/std@0.95.0/http/server.ts";

interface HookEvent {
    filter: (event: FreeswitchEvent) => boolean
    callback: (event: FreeswitchEvent) => void
}

type DialplanPlaner = Array<DialplanActioner>
type ChannelVariables = Array<{key: string, value: string}> | null

class IDGenerator {
    private _id = 0

    next(): string {
        return (this._id += 1) + ''
    }
}

type ConnectionRemover = () => void
type CallbackNewConnection = (conn: Connection, remover: ConnectionRemover) => void

// reverse connection
class Connection {
    private event_hooks: Array<HookEvent> = []
    private dialplans: Array<DialplanPlaner> = []
    private action_replies: Map<string, any> = new Map()

    private id_generator: IDGenerator
    private id: string
    
    constructor(id: string, id_generator: IDGenerator) {
        this.id = id
        this.id_generator = id_generator
    }

    async handle(req: ServerRequest) {
        this.process_actions(req)
    }

    async handle_event(event: FreeswitchEvent) {
        this.hook_event(event)
    }
    
    async action_wait_execute(cmd: string, arg: string, variables: ChannelVariables = null) {
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

        const dialplan = []
        // first append channel variables
        if (variables) {
            for(const variable of variables) {
                dialplan.push({set: variable.key, value: variable.value})
            }
        }
        dialplan.push({set: 'diluvio_request_id', value: this.id})
        
        // last we push action to run
        dialplan.push(action)
        
        this.dialplans.push(dialplan)

        const reply_val = await replie
        console.log(`action get reply ${reply_val} for ${action_id}`)
        return await resp
    }

    async action(cmd: string, arg: string, variables: ChannelVariables = null) {
        const action_id = this.next_action_id() + ''
        this.new_dialplan(action_id, {action: cmd, data: arg}, variables)
        
        return await new Promise((resolve) => {
            this.action_replies.set(action_id, resolve)
        })
    }

    async api(cmd: string, arg: string, variables: ChannelVariables = null) {
        const action_id = this.next_action_id() + ''
        this.new_dialplan(action_id, {api: cmd, arg: arg}, variables)
        
        return await new Promise((resolve) => {
            this.action_replies.set(action_id, resolve)
        })
    }

    on_event(hook: HookEvent) {
        this.event_hooks.push(hook)
    }

    private next_action_id(): number {
        return parseInt(this.id_generator.next())
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
        
        if (this.dialplans.length == 0) {
            console.log('no actions waiting')
            setTimeout(async () => {
                await this.process_actions(req)
            }, 1000)
            return
        }

        const dialplan = this.dialplans.shift()
        this.send_reply(req, dialplan)
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

    private new_dialplan(action_id: string, action: any, variables: ChannelVariables = null) {
        const reply = `/reply?diluvio_action_id=${action_id}&diluvio_request_id=${this.id}`
        action.reply = reply

        const dialplan = []
        // first append channel variables
        if (variables) {
            for(const variable of variables) {
                dialplan.push({set: variable.key, value: variable.value})
            }
        }
        dialplan.push({set: 'diluvio_request_id', value: this.id})
        
        // last we push action to run
        dialplan.push(action)

        this.dialplans.push(dialplan)

    }
}

// handle multiple connections
class ConnectionManager {
    private connections: Map<string, Connection> = new Map()
    private _conn_idx = 0
    private callback_new_connection: CallbackNewConnection | null = null
    private id_generator: IDGenerator

    constructor(id_generator: IDGenerator) {
        this.id_generator = id_generator
    }
    
    on_new_connection(cb: CallbackNewConnection) {
        this.callback_new_connection = cb
    }
    
    async handle(req: ServerRequest) {
        switch(true) {
            case req.url == '/':
                this.new_connection(req)
                break
            case req.url == '/event':
                this.handle_event(req)
                break
            case req.url.startsWith('/'):
                this.handle_conn(req)
                break
            default:
                console.error(`not know how to handle ${req.url}`)
                break
        }
    }

    private async new_connection(req: ServerRequest) {
        const id = this.next_id()
        const conn = new Connection(id, this.id_generator)
        this.connections.set(id, conn)

        //run dialplan

        if (this.callback_new_connection) {
            this.callback_new_connection(conn, () => {
                console.log('remove connection from pool')
                this.connections.delete(id)
            })
        }
        
        req.url = '/reply?diluvio_request_id='+id
        this.handle_conn(req)
    }

    private async handle_event(req: ServerRequest) {
        const body = await Deno.readAll(req.body)
        const event: any = JSON.parse(text_decoder.decode(body))

        const diluvio_request_id = event['variable_diluvio_request_id'] ?? null
        if (!diluvio_request_id) {
            console.log('omit event without request_id')
            return
        }

        const connection = this.connections.get(diluvio_request_id) ?? null
        if (!connection)
            throw new Error('try handle event not found handler for ' + diluvio_request_id)

        // TODO(bit4bit) when remove connection from pool?
        
        connection.handle_event(event)
    }

    private async handle_conn(req: ServerRequest) {
        const url = new URL('http://localhost' + req.url)
        const diluvio_request_id = url.searchParams.get('diluvio_request_id') ?? null
        
        if (!diluvio_request_id)
            throw new Error('try handle connection with request_id')

        const connection = this.connections.get(diluvio_request_id) ?? null
        if (!connection)
            throw new Error('try handle connection not found handler')

        connection.handle(req)
    }
    
    private next_id() {
        return this.id_generator.next()
    }
}

// run a lineal plan
async function plan(connection: Connection) {
    console.log('running plan')
    //console.log(await connection.action_wait_execute('answer', ''))
    console.log('#step 1')
    await connection.action_wait_execute('sleep', '1000')
    await connection.action_wait_execute('speak', 'flite|kal|ok this its great, it is working now')
    await connection.action_wait_execute('playback', 'tone_stream://L=3;%(100,100,350,440)')
    console.log('#step 2')
    await connection.action_wait_execute('playback', 'tone_stream://L=4;%(100,100,350,440)')
    console.log('#step 3')
    await connection.action_wait_execute('playback', 'tone_stream://L=5;%(100,100,350,440)')

    // TODO(bit4bit) not return
    await connection.action('hangup', 'OUT')
    console.log('###DONE PLAN')
}

async function httpi(port: number) {
    const id_generator = new IDGenerator()
    const manager = new ConnectionManager(id_generator)
    const server = serve({port: port})

    manager.on_new_connection(async (conn: Connection, remove: ConnectionRemover) => {
        await plan(conn)
        remove()
    })
    for await (const req of server) {
        console.log('main: ' + req.url);
        manager.handle(req)
    }
}

httpi(48000)


// freeswitch outbound handler
const dialplan = new DialplanHTTP('http://localhost:48000')
const publish = new PublishHTTP('http://localhost:48000/event')

const listener = Deno.listen({port: 44002})
console.log('listening tcp')

for await (const conn of listener) {
    (async () => {
        const diluvio = new Diluvio(dialplan, publish)
        const fsconn = new FreeswitchOutboundTCP(conn)        
        const diluvio_conn = diluvio.connect(fsconn)
        
        fsconn.process()
        await diluvio_conn.process()
        console.log('done connection to freeswitch')
    })()
}
