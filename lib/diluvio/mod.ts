export type FreeswitchEvent = Map<string, string>

export type FreeswitchEventCallback = (event: FreeswitchEvent) => void

export interface FreeswitchConnectioner {
    answer(): Promise<void>
    execute(cmd: string, arg: string): Promise<null | string>
    api(cmd: string, arg: string): Promise<null | string>

    hangup(reason: string): Promise<void>
    on_hangup(cb: FreeswitchEventCallback): void

}

// @bit4bit 2021-04-15, typescript permite
// obtener el type en tiempo de ejecucion
export type DialplanActionerParameter = {
    parameter: string
    value: string
}

export type DialplanActionerAction = {action: string, data?: string}
export type DialplanActioner = DialplanActionerAction | DialplanActionerParameter

export interface DialplanFetcher {
    fetch(url: string): Array<DialplanActioner> | []
}

export interface DiluvioConnectioner {
    process(): Promise<void>
}

export interface Publisher {
    // notifica evento
    event(destination: string, event: FreeswitchEvent): Promise<void>
}


class DiluvioConnection {
    private fsconn: FreeswitchConnectioner
    private dialplan: DialplanFetcher
    private publish: Publisher

    private hangup_destination?: string
    
    constructor(fsconn: FreeswitchConnectioner, dialplanFetcher: DialplanFetcher, publish: Publisher) {
        this.fsconn = fsconn
        this.dialplan = dialplanFetcher
        this.publish = publish

        //handlers
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
                
                switch(plan.action) {
                    case 'answer':
                        await this.fsconn.answer()
                        break
                    case 'echo':
                        await this.fsconn.execute('echo', '')
                        break
                    case 'dial':
                        // refactor
                        await this.fsconn.execute('dial', '')
                        const destination = plan.data as string ?? ''
                        if (destination != '') {
                            const new_dialplan = this.dialplan.fetch(destination)
                            return await this.run_dialplan(new_dialplan)
                        }
                        break
                    case 'hangup':
                        await this.fsconn.hangup(plan.data as string ?? 'NORMAL_CLEARING')
                        return
                    case 'parameter':

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
    
    connect(fsconn: FreeswitchConnectioner): DiluvioConnectioner {
        return new DiluvioConnection(fsconn, this.dialplanFetcher, this.publish)
    }
}
