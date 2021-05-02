export type FreeswitchEvent = {[key: string]: string}

export type FreeswitchEventCallback = (event: FreeswitchEvent) => void

export type FreeswitchCommandReply = string | null
export type FreeswitchApiResponse = string | null

export interface FreeswitchOutboundConnectioner {
    execute(cmd: string, arg: string): Promise<FreeswitchCommandReply>
    api(cmd: string, arg: string): Promise<FreeswitchApiResponse>
    
    hangup(reason: string): Promise<void>
    on_hangup(cb: FreeswitchEventCallback): void
    on_event(cb: FreeswitchEventCallback): void
    
}

// @bit4bit 2021-04-15, typescript permite
// obtener el type en tiempo de ejecucion
export type DialplanActionerParameter = {
    parameter: string
    value: string
}

export type DialplanActionerApi = {api: string, arg?: string, reply?: string}
export type DialplanActionerAction = {action: string, data?: string, dialplan?: string, reply?: string}
export type DialplanActioner = DialplanActionerAction | DialplanActionerParameter | DialplanActionerApi

export interface DialplanFetcher {
    fetch(url: string, data?: any): Promise<Array<DialplanActioner> | []>
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
    private event_destination?: string
    
    constructor(fsconn: FreeswitchOutboundConnectioner, dialplanFetcher: DialplanFetcher, publish: Publisher) {
        this.fsconn = fsconn
        this.dialplan = dialplanFetcher
        this.publish = publish

        //handlers for freeswitch events
        this.fsconn.on_event((event) => {
            this.publish.event(this.event_destination ?? '', event)
        })
        this.fsconn.on_hangup((event) => {
            this.publish.event(this.hangup_destination ?? '', event)
        })
    }
    
    async process() {
        const dialplan = await this.dialplan.fetch('/')
        await this.run_dialplan(dialplan)
    }

    private async run_dialplan(dialplan: Array<DialplanActioner>): Promise<void> {
        for(const item of dialplan) {
            
            // https://www.typescriptlang.org/docs/handbook/advanced-types.html
            if ("api" in item) {
                if (await this.execute_plan_api(item) == false) {
                    return
                }
            }
            else if("action" in item) {
                if (await this.execute_plan_action(item) == false) {
                    return
                }
            }
            else if ("parameter" in item) {
                await this.apply_parameter(item)
            }
        }
    }

    private async execute_plan_api(plan: DialplanActionerApi): Promise<boolean> {
        let reply: FreeswitchCommandReply | null = null

        reply = await this.fsconn.api(plan.api, plan.arg ?? '')

        // user wants result of execution command
        if (plan.reply) {
            await this.dialplan.fetch(plan.reply, reply)
        }
        
        return true
    }
    
    private async execute_plan_action(plan: DialplanActionerAction): Promise<boolean> {
        let reply: FreeswitchCommandReply | null = null

        switch(plan.action) {
            case 'hangup':
                await this.fsconn.hangup(plan.data as string ?? 'NORMAL_CLEARING')
                return false;
            default:
                    reply = await this.fsconn.execute(plan.action, plan.data ?? '')
        }
        
        // use new dialplan if asked
        if (plan.dialplan) {
            const reply_dialplan = await this.dialplan.fetch(plan.dialplan, {reply: reply})
            await this.run_dialplan(reply_dialplan)
        }

        return true
    }

    private async apply_parameter(param: DialplanActionerParameter) {
        switch(param.parameter) {
            case 'on_hangup':
                this.hangup_destination = param.value
                break
            case 'on_event':
                this.event_destination = param.value
                break
            default:
                throw new Error(`parameter unkown handler ${param.parameter}`)
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
