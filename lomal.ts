/**
 * implements https://docs.signalwire.com/topics/laml-xml/
 */
import { FreeswitchOutboundTCP, DialplanHTTP, PublishHTTP } from './lib/diluvio/impl.ts'
import { Diluvio, DialplanActioner } from './lib/diluvio/mod.ts'
import { text_decoder } from './lib/deps.ts'

import { serve, ServerRequest } from "https://deno.land/std@0.95.0/http/server.ts";

import { parse as xml_parse } from "https://deno.land/x/xml/mod.ts";

function httpUrl(port: number, postfix: string = '') {
    return `http://localhost:${port}${postfix}`
}

function response_json(req: any, data: any) {
    return req.respond({body: JSON.stringify(data)})
}

class LaxmlError extends Error {
}
class LaxmlTranslator {
    private app_url: string
    private handler: (req: ServerRequest) => void
    private response: any
    private actions: Array<string> = []

    private plan: Array<DialplanActioner> = []
    
    constructor(app_url: string) {
        this.app_url = app_url
        this.handler = this.handle_initial_request
    }
    
    handle(req: ServerRequest) {
        try {
            this.handler(req)
        } catch(e) {
            response_json(req, [
                {action: 'hangup'}
            ])
            throw e
        }
    }

    private async handle_initial_request(req: ServerRequest) {
        switch(req.url) {
            case '/':
                const resp = await fetch(this.app_url)
                if (resp.body === null)
                    throw new LaxmlError('invalid laxml body')
                
                const document: any = xml_parse(await resp.text())
                if (! ('Response' in document))
                    throw new LaxmlError('not element Response')

                this.response = document.Response
                this.actions = Object.keys(this.response)
                this.process()
                this.send_plan(req)
                break
            case '/event':
                break
            default:
                throw new LaxmlError(`not handler for ${req.url}`)
        }
    }

    // we process action by action
    private process() {
        const action: string | undefined= this.actions.shift()
        if (action === undefined)
            // TODO(bit4bit) close connection
            throw new LaxmlError('empty actions')
        
        const item: any = this.response[action]
        
        switch(action) {
            case 'Say':
                this.add_plan(
                    {action: 'speak', data: `flite|kal|${item}`}
                )
                this.process()
                break
            case 'Echo':
                this.add_plan({action: 'echo'})
                this.process()
                break
            case 'Hangup':
                this.add_plan({action: 'hangup'})
                break
        }
    }

    private add_plan(plan: DialplanActioner) {
        this.plan.push(plan)
    }
    
    private send_plan(req: ServerRequest) {
        console.log(`sending plan: ${JSON.stringify(this.plan)}`)
        response_json(req, this.plan)
        this.plan = []
    }
}

async function http_handler(port: number, app_url: string) {
    const translator = new LaxmlTranslator(app_url)
    
    const server = serve({port: port})
    for await (const req of server) {
        const body = await Deno.readAll(req.body)
        
        translator.handle(req)
    }
}

async function http_laxml_example(port: number) {
    const server = serve({port: port})
    for await (const req of server) {
        const body = await Deno.readAll(req.body)

        req.respond({body:`
<?xml version="1.0" encoding="UTF-8"?>
<Response>
 <Say>Connecting you ...</Say>
 <Echo/>
 <Hangup/>
</Response>
`})
    }
}

// main

// http handler
http_laxml_example(50000)
http_handler(48000, 'http://localhost:50000/')

// freeswitch outbound handler
const dialplan = new DialplanHTTP(httpUrl(48000), {'x-application': 'laml'})
const publish = new PublishHTTP(httpUrl(48000, '/event'), {'x-application': 'laml'})

const listener = Deno.listen({port: 44002})
console.log('listening tcp')

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
