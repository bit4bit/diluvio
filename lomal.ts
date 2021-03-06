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
    private handler: (req: ServerRequest) => Promise<void>
    private response: any
    private actions: Array<string> = []

    private plan: Array<DialplanActioner> = []
    
    constructor(app_url: string) {
        this.app_url = app_url
        this.handler = this.handle_answer
    }
    
    async handle(req: ServerRequest) {
        try {
            await this.handler(req)
        } catch(e) {
            response_json(req, [
                {action: 'hangup'}
            ])
            throw e
        }
    }

    private async fetch_response(url: string) {
        const resp = await fetch(url)
        if (resp.body === null)
            throw new LaxmlError('invalid laxml body')

        const document: any = xml_parse(await resp.text())
        if (! ('Response' in document))
            throw new LaxmlError('not element Response')

        this.response = document.Response
        this.actions = Object.keys(this.response)
    }

    private async handle_answer(req: ServerRequest) {
        const body = await Deno.readAll(req.body)
        switch(req.url) {
            case '/':
                this.handler = this.handle_initial_request
                this.add_plan({action: 'answer', dialplan: '/'})
                this.send_plan(req)
                break
            case '/event':
                const event: any = JSON.parse(text_decoder.decode(body))
                if (event['event-name'] == 'CHANNEL_DATA') {
                    console.log(event)
                    /*this.handler = this.handle_initial_request

                    await this.fetch_response(this.app_url)
                    this.process()
                    this.send_plan(req)*/
                }
                break
            default:
                throw new LaxmlError(`not handler for ${req.url}`)
        }
    }
    
    private async handle_initial_request(req: ServerRequest) {

        switch(req.url) {
            case '/':
                await this.fetch_response(this.app_url)
                this.process()
                this.send_plan(req)
                break
            case '/event':
                const body = await Deno.readAll(req.body)
                const event: any = JSON.parse(text_decoder.decode(body))

                if (event['event-name'] == 'CHANNEL_EXECUTE_COMPLETE' && event['application'] == 'answer') {
                    console.log(event)

                }
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
            case 'Gather':
                const gather_params = {timeout: 5000,
                                       action: '',
                                       terminators: '#',
                                       min: 0, max: 128,
                                       tries: 3,
                                       file: 'silence_stream://',
                                       invalid_file: 'silence_stream://250'}
                if ('@input' in item) {
                    if (item['@input'] != 'dtmf') {
                        throw new LaxmlError('only supported dtmf input')
                    }
                }

                if ('@action' in item) {
                    gather_params.action = item['@action']
                }
                
                if ('@timeout' in item) {
                    const gather_timeout = parseInt(item['@timeout'])
                    gather_params.timeout = gather_timeout
                }

                if ('@numDigits' in item) {
                    const gather_digits = parseInt(item['@numDigits'])
                    gather_params.min = gather_digits
                    gather_params.max = gather_digits
                }
                
                if ('Say' in item) {
                    gather_params.file = `say:'${item.Say}'`
                }

                // only dtmf
                this.add_plan(
                    {set: 'gather_action', value: gather_params.action},
                )
                this.add_plan(
                    {action: 'play_and_get_digits', data: `${gather_params.min} ${gather_params.max} ${gather_params.tries} ${gather_params.timeout} ${gather_params.terminators} ${gather_params.file} ${gather_params.invalid_file} diluvio_gather \\d+`}
                )
                this.handler = this.handle_gather
                break
            case 'Say':
                this.add_plan(
                    {action: 'speak', data: `flite|kal|${item}`}
                )
                this.process()
                break
            case 'Echo':
                this.add_plan({action: 'echo', execute: '/timeout', execute_data: parseInt(item["@timeout"] ?? '1000')})
                this.handler = this.handle_timeout
                break
            case 'Hangup':
                this.add_plan({action: 'hangup'})
                break
        }
    }

    private async handle_gather(req: ServerRequest) {
        const body = await Deno.readAll(req.body)
        
        if (req.url == '/event') {
            const event: any = JSON.parse(text_decoder.decode(body))
            //console.log(event)
            if (event['event-name'] == 'CHANNEL_EXECUTE_COMPLETE' && event['application'] == 'play_and_get_digits') {
                const digits = event['variable_diluvio_gather']
                const action_url = decodeURI(event['variable_gather_action'])

                if (digits == undefined) {
                    this.handler = this.handle_initial_request
                    this.process()
                    this.send_plan(req)
                } else {
                    console.log(`get dtmf digits ${digits} calling ${action_url}`)
                    this.fetch_response(`${action_url}?digits=${digits}`)
                    this.process()
                    this.send_plan(req)
                }
            }
        }
    }
    
    private async handle_timeout(req: ServerRequest) {
        console.log(`handle_timeout: ${req.url}`)

        if (req.url == '/event')
            return
        
        if (req.url != '/timeout')
            throw new LaxmlError(`not found timeout endpoint ${req.url}`)
        const body = text_decoder.decode(await Deno.readAll(req.body))
        const timeout = parseInt(body)
        setTimeout(() => {
            this.handler = this.handle_initial_request
            this.process()
            this.send_plan(req)
        }, timeout)
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
    // TODO(bit4bit) not handle multiple calls lose context
    const translator = new LaxmlTranslator(app_url)

    const server = serve({port: port})
    for await (const req of server) {
        await translator.handle(req)
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
 <Echo timeout="2000"/>
 <Hangup/>
</Response>
`})
    }
}

async function http_laxml_example_gather(port: number) {
    const server = serve({port: port})
    for await (const req of server) {
        const body = await Deno.readAll(req.body)

        req.respond({body:`
<?xml version="1.0" encoding="UTF-8"?>
<Response>
 <Gather action="http://localhost:50001" numDigits="5">
  <Say>press one for technicial support</Say>
</Gather>
<Say>Invalid input goodbye</Say>
</Response>
`})
    }
}


// main

// http handler
http_laxml_example_gather(50000)
http_laxml_example(50001)
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
