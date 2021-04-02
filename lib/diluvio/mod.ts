
export interface FreeswitchConnectioner {
    answer(): void
    execute(cmd: string, arg: string): null | string
    api(cmd: string, arg: string): null | string
}

export type DialplanActioner = {action: string}

export interface DialplanFetcher {
    fetch(url: string): Array<DialplanActioner> | []
}

export interface DiluvioConnectioner {
    process(): Promise<void>
}

class DiluvioConnection {
    private fsconn: FreeswitchConnectioner
    private dialplan: DialplanFetcher
    
    constructor(fsconn: FreeswitchConnectioner, dialplanFetcher: DialplanFetcher) {
        this.fsconn = fsconn
        this.dialplan = dialplanFetcher
    }
    
    async process() {
        const dialplan = this.dialplan.fetch('/')
        
        for(const plan of dialplan) {
            switch(plan.action) {
                case 'answer':
                    this.fsconn.answer()
                    break
                case 'echo':
                    this.fsconn.execute('echo', '')
                    break
            }
        }
    }
}

export class Diluvio {

    static connect(fsconn: FreeswitchConnectioner, dialplanFetcher: DialplanFetcher): DiluvioConnectioner {
        return new DiluvioConnection(fsconn, dialplanFetcher)
    }
}
