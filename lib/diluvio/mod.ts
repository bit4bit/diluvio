export type FreeswitchEvent = Map<string, string>

export type FreeswitchEventCallback = (event: FreeswitchEvent) => void

export interface FreeswitchConnectioner {
    answer(): Promise<void>
    execute(cmd: string, arg: string): Promise<null | string>
    api(cmd: string, arg: string): Promise<null | string>

    hangup(reason: string): Promise<void>
    on_hangup(cb: FreeswitchEventCallback): Promise<void>
}

type DialplanActionerParameter = {name: string, publish: string}
export type DialplanActioner = {action: string, data?: DialplanActionerParameter | string} 

export interface DialplanFetcher {
    fetch(url: string): Array<DialplanActioner> | []
}

export interface DiluvioConnectioner {
    process(): Promise<void>
}

export interface Publisher {
    response(destination: string, event: FreeswitchEvent): Promise<void>
}

class DiluvioConnection {
    private fsconn: FreeswitchConnectioner
    private dialplan: DialplanFetcher
    private publish: Publisher
    
    constructor(fsconn: FreeswitchConnectioner, dialplanFetcher: DialplanFetcher, publish: Publisher) {
        this.fsconn = fsconn
        this.dialplan = dialplanFetcher
        this.publish = publish
    }
    
    async process() {
        const dialplan = this.dialplan.fetch('/')
        
        for(const plan of dialplan) {
            switch(plan.action) {
                case 'answer':
                    await this.fsconn.answer()
                    break
                case 'echo':
                    await this.fsconn.execute('echo', '')
                    break
                case 'hangup':
                    await this.fsconn.hangup(plan.data as string ?? 'NORMAL_CLEARING')
                case 'parameter':
                    if (!plan.data) {
                        console.info(`omiting parameter ${JSON.stringify(plan)}`)
                        continue
                    }
                    const param = plan.data as DialplanActionerParameter
                    switch(param.name) {
                        case 'on_hangup':
                            this.fsconn.on_hangup((event) => {
                                this.publish.response(param.publish, event)
                            })
                            break
                        default:
                            throw new Error(`parameter unkown handler ${param.name}`)
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
