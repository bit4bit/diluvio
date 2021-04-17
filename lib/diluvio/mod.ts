export type FreeswitchEvent = Map<string, string>

export type FreeswitchEventCallback = (event: FreeswitchEvent) => void

export type FreeswitchCommandReply = string | null
export type FreeswitchApiReply = string | null

export interface FreeswitchOutboundConnectioner {
    answer(): Promise<FreeswitchCommandReply>
    execute(cmd: string, arg: string): Promise<FreeswitchCommandReply>
    api(cmd: string, arg: string): Promise<FreeswitchApiReply>
    
    hangup(reason: string): Promise<void>
    on_hangup(cb: FreeswitchEventCallback): void
    
}

// @bit4bit 2021-04-15, typescript permite
// obtener el type en tiempo de ejecucion
export type DialplanActionerParameter = {
    parameter: string
    value: string
}

export type DialplanActionerAction = {action: string, data?: string, dialplan?: string}
export type DialplanActioner = DialplanActionerAction | DialplanActionerParameter

export interface DialplanFetcher {
    fetch(url: string, data?: any): Array<DialplanActioner> | []
}

export interface DiluvioConnectioner {
    process(): Promise<void>
}

export interface Publisher {
    // notifica evento
    event(destination: string, event: FreeswitchEvent): Promise<void>
}


class DiluvioConnection {
    private fsconn: FreeswitchOutboundConnectioner
    private dialplan: DialplanFetcher
    private publish: Publisher

    private hangup_destination?: string
    
    constructor(fsconn: FreeswitchOutboundConnectioner, dialplanFetcher: DialplanFetcher, publish: Publisher) {
        this.fsconn = fsconn
        this.dialplan = dialplanFetcher
        this.publish = publish

        //handlers for freeswitch events
        this.fsconn.on_hangup((event) => {
            this.publish.event(this.hangup_destination || 'http://localhost', event)
        })
    }
    
    async process() {
        const dialplan = this.dialplan.fetch('/')
        await this.run_dialplan(dialplan)
    }

    private async run_dialplan(dialplan: Array<DialplanActioner>): Promise<void> {
        for(const item of dialplan) {
            // https://www.typescriptlang.org/docs/handbook/advanced-types.html
            if("action" in item) {
                const plan = item as DialplanActionerAction
                let reply: FreeswitchCommandReply | null = null
                        
                switch(plan.action) {
                    case 'answer':
                        reply = await this.fsconn.answer()
                        break
                    case 'echo':
                        reply = await this.fsconn.execute('echo', '')
                        break
                    case 'hangup':
                        await this.fsconn.hangup(plan.data as string ?? 'NORMAL_CLEARING')
                        return
                }

                // use new dialplan if asked
                if (plan.dialplan) {
                    const reply_dialplan = this.dialplan.fetch(plan.dialplan, {reply: reply})
                    await this.run_dialplan(reply_dialplan)
                    return
                }
            }
            else if ("parameter" in item) {
                const param = item as DialplanActionerParameter
                
                switch(param.parameter) {
                    case 'on_hangup':
                        this.hangup_destination = param.value
                        break
                    default:
                        throw new Error(`parameter unkown handler ${param.parameter}`)
                }
            }
        }
    }
}

export class Diluvio {
    private dialplanFetcher: DialplanFetcher
    private publish: Publisher
    
    constructor(dialplanFetcher: DialplanFetcher, publish: Publisher) {
        this.dialplanFetcher = dialplanFetcher
        this.publish = publish
    }
    
    connect(fsconn: FreeswitchOutboundConnectioner): DiluvioConnectioner {
        return new DiluvioConnection(fsconn, this.dialplanFetcher, this.publish)
    }
}
