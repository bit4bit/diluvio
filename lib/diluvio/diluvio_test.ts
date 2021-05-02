import {
    assertArrayIncludes,
    assertEquals,
    assertThrows
} from 'https://deno.land/std@0.88.0/testing/asserts.ts'

import { Diluvio, DialplanFetcher, Publisher, FreeswitchOutboundConnectioner } from './mod.ts'
import type { FreeswitchEvent, FreeswitchEventCallback } from './mod.ts'

class FreeswitchConnectionFake implements FreeswitchOutboundConnectioner {
    public actions: Array<string> = []
    public hangups_cb: Array<FreeswitchEventCallback> = []
    public events_cb: Array<FreeswitchEventCallback> = []

    public execute_will_return: {[key: string]: any} = []
    public api_will_return: {[key: string]: any} = []
    
    async execute(cmd: string) {
        this.actions.push(`execute: ${cmd}`)
        return this.execute_will_return[cmd] ?? null
    }
    
    async api(cmd: string, arg: string) {
        this.actions.push(`api: ${cmd} ${arg}`)
        return this.api_will_return[cmd] ?? null
    }

    async hangup(reason: string) {
        this.actions.push('hangup')
        for(const cb of this.hangups_cb) {
            cb({})
        }
    }
    
    on_hangup(cb: FreeswitchEventCallback) {
        this.hangups_cb.push(cb)
    }

    on_event(cb: FreeswitchEventCallback) {
        this.events_cb.push(cb)
    }
}

class DialplanFetchEchoFake implements DialplanFetcher {
    async fetch(url: string) {
        return [
            //configuracion del canal
            {parameter: 'on_hangup', value: 'http://localhost'},
            {action: 'answer'},
            {action: 'echo'},
            {action: 'hangup'}
        ]
    }
}

class DialplanFetchWithNewDialplanFake implements DialplanFetcher {
    async fetch(url: string) {
        switch(url) {
            case '/':
                return [
                    //configuracion del canal
                    {parameter: 'on_hangup', value: 'http://localhost'},
                    {action: 'answer', dialplan: 'http://localhost/after-answer'},
                ]
            case 'http://localhost/after-answer':
                return [
                    {action: 'hangup'}
                ]
            default:
                return [
                    {action: 'echo'}
                ]
        }
    }
}

class DialplanFetchWithReply implements DialplanFetcher {
    public actions: Array<string> = []
    
    async fetch(url: string, data: any) {
        switch(url) {
            case '/':
                return [
                    {action: 'answer'},
                    {api: 'uptime', reply: 'http://localhost/uptime-reply'}
                ]
            case 'http://localhost/uptime-reply':
                this.actions.push(data)
                return []
            default:
                return []
        }
    }
}

class DialplanFetchExecuteWithReply implements DialplanFetcher {
    public actions: Array<string> = []
    
    async fetch(url: string, data: any) {
        switch(url) {
            case '/':
                return [
                    {action: 'answer', reply: '/answer-reply'},
                ]
            case '/answer-reply':
                this.actions.push(data)
                return []
            default:
                return []
        }
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

    assertEquals(fsconn.actions, ['execute: answer', 'execute: echo', 'hangup'])
    assertEquals(publish.actions, ['to: http://localhost'])
})


Deno.test('iteration 3 outbound', async () => {
    const fsconn = new FreeswitchConnectionFake()
    const dialplanFetch = new DialplanFetchWithNewDialplanFake()
    const publish = new PublishFake()
    
    const diluvio = new Diluvio(dialplanFetch, publish)
    await diluvio.connect(fsconn).process()

    assertEquals(fsconn.actions, ['execute: answer', 'hangup'])
})

Deno.test('iteration 4 outbound', async () => {
    const fsconn = new FreeswitchConnectionFake()
    const dialplanFetch = new DialplanFetchWithReply()
    const publish = new PublishFake()

    fsconn.api_will_return['uptime'] = 999
    
    const diluvio = new Diluvio(dialplanFetch, publish)
    await diluvio.connect(fsconn).process()

    assertEquals(fsconn.actions, ['execute: answer', 'api: uptime '])
    assertEquals(dialplanFetch.actions, [999])
})

Deno.test('iteration 5 outbound', async () => {
    const fsconn = new FreeswitchConnectionFake()
    const dialplanFetch = new DialplanFetchExecuteWithReply()
    const publish = new PublishFake()

    fsconn.execute_will_return['answer'] = 'OK'
    
    const diluvio = new Diluvio(dialplanFetch, publish)
    await diluvio.connect(fsconn).process()

    assertEquals(fsconn.actions, ['execute: answer'])
    assertEquals(dialplanFetch.actions, ['OK'])
})
