/**
 * simple implementation of ACD system
 */
import { FreeswitchOutboundTCP, DialplanHTTP, PublishHTTP } from './lib/diluvio/impl.ts'
import { Diluvio } from './lib/diluvio/mod.ts'
import { text_decoder } from './lib/deps.ts'

import { serve } from "https://deno.land/std@0.95.0/http/server.ts";

function httpUrl(port: number, postfix: string = '') {
    return `http://localhost:${port}${postfix}`
}

class Callcenter {
    private agents: Map<string,any> = new Map()
    private members: Map<string,any> = new Map()

    member_in(id: string, metadata: any) {
        this.members.set(id, metadata)
    }

    member_out(id: string) {
        this.members.delete(id)
    }
    
    agent_login(id: string, metadata: any) {
        this.agents.set(id, metadata)
    }

    agent_logout(id: string) {
        this.agents.delete(id)
    }

    agents_name(): Array<string> {
        const keys: Array<string> = []
        for(const agent of this.agents.keys())
            keys.push(agent)
        return keys
    }
}


function get_event(body: any) {
    return JSON.parse(text_decoder.decode(body))
}

function response_json(req: any, data: any) {
    return req.respond({body: JSON.stringify(data)})
}

async function handle_agent_login(callcenter: any, req: any, body: any) {
    console.log(req.url)
    switch(req.url) {
        case '/':
            const plan = [
                {action: 'answer'},
                {action: 'playback', data: 'ivr/ivr-you_are_now_logged_in.wav'},
                {action: 'hangup'}
            ]
            response_json(req, plan)
            return
        case '/event':
            const event = get_event(body)
            if (event['event-name'] == 'CHANNEL_DATA') {
                const username = event['caller-username']
                console.log(`agent login ${username}`)
                callcenter.agent_login(username, event)
            }
            break
    }
}

async function handle_agent_logout(callcenter: any, req: any, body: any) {
    console.log(req.url)
    switch(req.url) {
        case '/':
            const plan = [
                {action: 'answer'},
                {action: 'playback', data: 'ivr/ivr-you_are_now_logged_out.wav'},
                {action: 'hangup'}
            ]
            response_json(req, plan)
            return
        case '/event':
            const event = get_event(body)
            if (event['event-name'] == 'CHANNEL_DATA') {
                const username = event['caller-username']
                console.log(`agent logout ${username}`)
                callcenter.agent_logout(username)
            }
            break
    }
}

async function handle_member_inbound(callcenter: any, req: any, body: any) {
    console.log(req.url)

    const agents_bridge = () => {
        const agents_name: Array<string> = callcenter.agents_name()
        const bridge = agents_name.filter(agent => agent !== undefined).map(agent => `user/${agent}`).join('|')

        return bridge
    }
    
    switch(req.url) {
        case '/':
            const plan = [
                {action: 'answer'},
                {set: 'instant_ringback', value: 'true'},
                {set: 'ringback', value: '${us-ring}'},
                {set: 'hangup_after_bridge', value: 'true'},
                {set: 'continue_on_fail', value: 'CALL_REJECTED,USER_BUSY,NO_ANSWER'},
                {set: 'effective_caller_id_number', value: '1230918230'},
                // try first call and enter loop
                {action: 'bridge', data: agents_bridge(), reply: '/agent_bridge'}
            ]
            response_json(req, plan)
            return
            // loop until agent answer
            // strategy ring sequential
        case '/agent_bridge':
            const plan_bridge = [
                {action: 'sleep', data: '1000'},
                {action: 'bridge', data: agents_bridge(), reply: '/agent_bridge'}
            ]
            response_json(req, plan_bridge)
            return
        case '/event':
            const event = get_event(body)
            const event_name = event['event-name']
            console.log(event['event-name'])
            switch(event_name) {
                case 'CHANNEL_DATA':
                    const username = event['caller-username']
                    const queue_name = event['variable_queue_name']
                    console.log(`member inbound for queue ${queue_name}`)
                    break
                case 'CHANNEL_HANGUP':
                    console.log(event)
                    break
            }
            break
    }
}

async function listen_application(http_port: number) {
    const callcenter = new Callcenter()
    
    const server = serve({port: http_port})
    for await (const req of server) {
        const body = await Deno.readAll(req.body)

        const application = req.headers.get('x-application')
        switch(application) {
            case 'agent-login':
                await handle_agent_login(callcenter, req, body)
                break
            case 'agent-logout':
                await handle_agent_logout(callcenter, req, body)
                break
            case 'member-inbound':
                await handle_member_inbound(callcenter, req, body)
                break
            default:
                console.log('unknown application')
        }
    }
}

async function listen_agent_login(port: number, http_port: number) {
    const dialplan = new DialplanHTTP(httpUrl(http_port), {'x-application': 'agent-login'})
    const publish = new PublishHTTP(httpUrl(http_port, '/event'), {'x-application': 'agent-login'})

    const listener = Deno.listen({port: port})
    console.log('listen agent login')
    for await (const conn of listener) {
        new Promise(async (resolve) => {
            
            const diluvio = new Diluvio(dialplan, publish)
            const fsconn = new FreeswitchOutboundTCP(conn)        
            const diluvio_conn = diluvio.connect(fsconn)
            
            fsconn.process()
            await diluvio_conn.process()
            
            console.log('connection listen agent login')
            resolve(true)
        })
    }
}

async function listen_agent_logout(port: number, http_port: number) {
    const dialplan = new DialplanHTTP(httpUrl(http_port), {'x-application': 'agent-logout'})
    const publish = new PublishHTTP(httpUrl(http_port, '/event'), {'x-application': 'agent-logout'})

    const listener = Deno.listen({port: port})
    console.log('listen agent logout')
    
    for await (const conn of listener) {
        new Promise(async (resolve) => {
            
            const diluvio = new Diluvio(dialplan, publish)
            const fsconn = new FreeswitchOutboundTCP(conn)        
            const diluvio_conn = diluvio.connect(fsconn)
            
            fsconn.process()
            await diluvio_conn.process()
            
            console.log('connection listen agent logout')
            resolve(true)
        })
    }
}

async function listen_member_inbound(port: number, http_port: number) {
    const dialplan = new DialplanHTTP(httpUrl(http_port), {'x-application': 'member-inbound'})
    const publish = new PublishHTTP(httpUrl(http_port, '/event'), {'x-application': 'member-inbound'})

    const listener = Deno.listen({port: port})
    console.log('listen member inbound')
    
    for await (const conn of listener) {
        new Promise(async (resolve) => {
            
            const diluvio = new Diluvio(dialplan, publish)
            const fsconn = new FreeswitchOutboundTCP(conn)        
            const diluvio_conn = diluvio.connect(fsconn)
            
            fsconn.process()
            await diluvio_conn.process()
            
            console.log('connection listen member inbound')
            resolve(true)
        })
    }
}

// main
listen_application(45000)
// socket 127.0.0.1:44000 async full
listen_agent_login(44000, 45000)
// socket 127.0.0.1:44001 async full
listen_agent_logout(44001, 45000)
// socket 127.0.0.1:44000 sync full
listen_member_inbound(44002, 45000)
