import { FreeswitchOutboundTCP, DialplanHTTP, PublishHTTP } from './lib/diluvio/impl.ts'
import { Diluvio } from './lib/diluvio/mod.ts'
import { text_decoder } from './lib/deps.ts'

import { serve } from "https://deno.land/std@0.95.0/http/server.ts";

const dialplan = new DialplanHTTP('http://localhost:43001')
const publish = new PublishHTTP('http://localhost:43001')

//example of dialplan
const server = serve({port: 43001})
new Promise(async (resolve) => {
    for await (const req of server) {
        console.log(req.url)
        switch(req.url) {
            case '/event':
                const body = await Deno.readAll(req.body)
                //console.log(text_decoder.decode(body))
            case '/':
                const plan = [{parameter: 'on_hangup', value: '/hangup'},
                              {parameter: 'on_event', value: '/event'},
                              {action: 'answer'},
                              {action: 'echo'},
                              {action: 'hangup'}]
                req.respond({body: JSON.stringify(plan)})
                break
            default:
                req.respond({body: JSON.stringify([{action: 'hangup'}])})
        }

    }
})


//run main logic
const listener = Deno.listen({port: 43000})
console.log('listening on 0.0.0.0:43000')
for await (const conn of listener) {
    new Promise(async (resolve) => {
        const diluvio = new Diluvio(dialplan, publish)
        const fsconn = new FreeswitchOutboundTCP(conn)        
        fsconn.process()
        await diluvio.connect(fsconn).process()
        
        console.log('connection done')
        resolve(true)
    })
}
