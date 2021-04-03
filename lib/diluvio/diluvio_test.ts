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
        for(const cb of this.hangups_cb) {
            cb(new Map())
        }
    }
    
    async on_hangup(cb: FreeswitchEventCallback) {
        this.hangups_cb.push(cb)
    }
}

class DialplanFetchFake implements DialplanFetcher {
    fetch(url: string) {
        return [
            {action: 'parameter', data: {name: 'on_hangup', publish: 'http://localhost'}},
            {action: 'answer'},
            {action: 'echo'},
            {action: 'hangup'}
        ]
    }
}

class PublishFake implements Publisher {
    public actions: Array<string> = []
        
    async response(destination: string, event: FreeswitchEvent) {
        this.actions.push(`to: ${destination}`)
    }
}

Deno.test('iteration 1 outbound', async () => {
    const fsconn = new FreeswitchConnectionFake()
    const dialplanFetch = new DialplanFetchFake()
    const publish = new PublishFake()
    
    const diluvio = new Diluvio(dialplanFetch, publish)
    await diluvio.connect(fsconn).process()

    assertEquals(fsconn.actions, ['answer', 'execute: echo'])
    assertEquals(publish.actions, ['to: http://localhost'])
})
