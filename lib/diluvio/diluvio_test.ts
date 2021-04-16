import {
    assertArrayIncludes,
    assertEquals,
    assertThrows
} from 'https://deno.land/std@0.88.0/testing/asserts.ts'

import { Diluvio, DialplanFetcher, Publisher, FreeswitchConnectioner } from './mod.ts'
import type { FreeswitchEvent, FreeswitchEventCallback } from './mod.ts'

class FreeswitchConnectionFake implements FreeswitchConnectioner {
    public actions: Array<string> = []
    public hangups_cb: Array<FreeswitchEventCallback> = []
    
    async answer() {
        this.actions.push('answer')
    }

    async execute(cmd: string) {
        this.actions.push(`execute: ${cmd}`)
        return null
    }
    
    async api(cmd: string, arg: string) {
        this.actions.push(`api: ${cmd} ${arg}`)
        return null
    }

    async hangup(reason: string) {
        this.actions.push('hangup')
        for(const cb of this.hangups_cb) {
            cb(new Map())
        }
    }
    
    async on_hangup(cb: FreeswitchEventCallback) {
        this.hangups_cb.push(cb)
    }

}

class DialplanFetchEchoFake implements DialplanFetcher {
    fetch(url: string) {
        return [
            //configuracion del canal
            {parameter: 'on_hangup', value: 'http://localhost'},
            {action: 'answer'},
            {action: 'echo'},
            {action: 'hangup'}
        ]
    }
}

class DialplanFetchDialFake implements DialplanFetcher {
    fetchs: Array<string> = []
    
    fetch(url: string) {
        this.fetchs.push(url)

        switch(url) {
            case '/':
                return [
                    {action: 'dial', data: 'http://localhost/after-dial'}
                ]
                break
            case 'http://localhost/after-dial':
                return [
                    {action: 'hangup'}
                ]
                break
        }

        return []
    }
}

class PublishFake implements Publisher {
    public actions: Array<string> = []
        
    async event(destination: string, event: FreeswitchEvent) {
        this.actions.push(`to: ${destination}`)
    }
}

Deno.test('iteration 1 outbound', async () => {
    const fsconn = new FreeswitchConnectionFake()
    const dialplanFetch = new DialplanFetchEchoFake()
    const publish = new PublishFake()
    
    const diluvio = new Diluvio(dialplanFetch, publish)
    await diluvio.connect(fsconn).process()

    assertEquals(fsconn.actions, ['answer', 'execute: echo', 'hangup'])
    assertEquals(publish.actions, ['to: http://localhost'])
})


Deno.test('iteration 2 outbound sub dialplan', async () => {
    const fsconn = new FreeswitchConnectionFake()
    const dialplanFetch = new DialplanFetchDialFake()
    const publish = new PublishFake()
    
    const diluvio = new Diluvio(dialplanFetch, publish)
    await diluvio.connect(fsconn).process()

    assertEquals(fsconn.actions, ['execute: dial', 'hangup'])
    assertEquals(dialplanFetch.fetchs, ['/', 'http://localhost/after-dial'])
})

