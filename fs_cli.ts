import { FreeswitchInboundTCP, FreeswitchCallbackType } from './lib/diluvio/impl.ts'
import { text_encoder } from './lib/deps.ts'

const host = Deno.args[0]
const port = parseInt(Deno.args[1])

const conn = await Deno.connect({port: port, hostname: host})
const client = new FreeswitchInboundTCP(conn)
 
client.process()

const reply_auth: string = await client.auth('cloudpbx')
if (reply_auth.startsWith('+OK accepted'))
    console.log('logged in')
else {
    console.log(reply_auth)
    Deno.exit(1)
}

console.log('query uptime')
const uptime: string = await client.api('uptime', '')
console.log(uptime.trim())
