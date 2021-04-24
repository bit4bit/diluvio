import { FreeswitchInboundTCP, FreeswitchCallbackType } from './lib/diluvio/impl.ts'
import { FreeswitchEvent } from './lib/diluvio/mod.ts'
import { text_encoder } from './lib/deps.ts'

const host = Deno.args[0]
const port = parseInt(Deno.args[1])
const pass = Deno.args[2].trim()

if (Deno.args.length != 3) {
    console.log("monitor_events <host> <port> <pass>")
    Deno.exit(1)
}

const conn = await Deno.connect({port: port, hostname: host})
const client = new FreeswitchInboundTCP(conn)
 
client.process()

client.on(FreeswitchCallbackType.Event, (event: FreeswitchEvent) => {
    console.log(event)
})

console.log('logging')
const reply_auth: string = await client.auth(pass)
if (reply_auth.startsWith('+OK accepted')) {
    await client.event('json', ['ALL'])
} else {
    console.log(reply_auth)
    Deno.exit(1)
}
