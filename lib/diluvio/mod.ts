export type FreeswitchEvent = {[key: string]: string}

export type FreeswitchEventCallback = (event: FreeswitchEvent) => void

export type FreeswitchCommandReply = string | null
export type FreeswitchApiResponse = string | null

export interface FreeswitchOutboundConnectioner {
    execute(cmd: string, arg: string): Promise<FreeswitchCommandReply>
    api(cmd: string, arg: string): Promise<FreeswitchApiResponse>
    set_variable(name: string, value: string): Promise<void>
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

export type DialplanActionerSet = {set: string, value: string}
export type DialplanActionerApi = {api: string, arg?: string, reply?: string}
// TODO(bit4bit) dialplan y reply se pueden unir en un solo tipo
export type DialplanActionerAction = {action: string, data?: string, dialplan?: string, reply?: string, execute?: string, execute_data?: any}
export type DialplanActioner = DialplanActionerAction | DialplanActionerParameter | DialplanActionerApi | DialplanActionerSet
export type Dialplan = Array<DialplanActioner>

export class DialplanStop extends Error {
}


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
            else if("set" in item) {
                await this.execute_plan_set_variable(item)
                continue
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

    private async execute_plan_set_variable(variable: DialplanActionerSet) {
        await this.fsconn.set_variable(variable.set, variable.value)
    }
    
    private async execute_plan_api(plan: DialplanActionerApi): Promise<boolean> {
        let reply: FreeswitchCommandReply | null = null

        reply = await this.fsconn.api(plan.api, plan.arg ?? '')

        // user wants result of execution command
        if (plan.reply) {
            if (await this.try_new_dialplan(plan.reply, reply) == false)
                return false
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
                    let continue_dialplan: Promise<boolean> = new Promise((resolve) => {resolve(true)})
                
                if (plan.execute) {
                    continue_dialplan = this.try_new_dialplan(plan.execute, plan.execute_data)
                }
                
                reply = await this.fsconn.execute(plan.action, plan.data ?? '')

                if ((await continue_dialplan) == false) {
                    return false
                }
        }

        // ask for reply
        if (plan.reply) {
            if (await this.try_new_dialplan(plan.reply, reply) == false)
                return false
        }
        
        // use new dialplan if asked
        if (plan.dialplan) {
            if (await this.try_new_dialplan(plan.dialplan, reply) == false)
                return false
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

    private async try_new_dialplan(url: string, data?: any) {
        try {
            const new_dialplan = await this.dialplan.fetch(url, data)
            if (new_dialplan.length > 0) {
                await this.run_dialplan(new_dialplan)
                return false
            }
            
            return true
        } catch(error) {
            if (error instanceof DialplanStop)
                return false
            throw error
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
