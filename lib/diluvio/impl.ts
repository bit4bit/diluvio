import { FreeswitchOutboundConnectioner } from './mod.ts'

export interface PduOptions {
    command: string
    app: string
    arg?: string
}

export class Pdu {
    static async writeTo(opts: PduOptions, w: Deno.Writer) {
        const pdu = [`sendmsg
call-command: ${opts.command}
execute-app-name: ${opts.app}`]
        if (opts.arg) {
            pdu.push(`execute-app-arg: ${opts.arg}`)
        }
        pdu.push("\n")
        
        const data = new TextEncoder().encode(pdu.join("\n"))
        await w.write(data)
    }
}

