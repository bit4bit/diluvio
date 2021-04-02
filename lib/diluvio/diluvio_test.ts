import {
    assertArrayIncludes,
    assertEquals,
    assertThrows
} from 'https://deno.land/std@0.88.0/testing/asserts.ts'

import { Diluvio, DialplanFetcher, FreeswitchConnectioner } from './mod.ts'

class FreeswitchConnectionFake implements FreeswitchConnectioner {
    public actions: Array<string> = []
    
    answer() {
        this.actions.push('answer')
        return null
    }

    execute(cmd: string) {
        this.actions.push(`execute: ${cmd}`)
        return null
    }
    
    api(cmd: string, arg: string) {
        this.actions.push(`api: ${cmd} ${arg}`)
        return null
    }
}

class DialplanFetchFake implements DialplanFetcher {
    fetch(url: string) {
        return [
            {action: 'answer'},
            {action: 'echo'}
        ]
    }
}

Deno.test('iteration 1 outbound', async () => {
    const fsconn = new FreeswitchConnectionFake()
    const dialplanFetch = new DialplanFetchFake()
    
    const conn = Diluvio.connect(fsconn, dialplanFetch)
    await conn.process()

    assertEquals(fsconn.actions, ['answer', 'execute: echo'])
})
