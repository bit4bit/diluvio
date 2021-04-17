import {
    assertArrayIncludes,
    assertEquals,
    assertThrows
} from 'https://deno.land/std@0.88.0/testing/asserts.ts'

import {
    StringWriter
} from "https://deno.land/std@0.88.0/io/mod.ts";

import { Pdu } from './impl.ts'


Deno.test('sendmsg without arg', async () => {
    const out = new StringWriter()
    
    await Pdu.writeTo({command: 'execute', app: 'hangup'}, out)
    assertEquals(out.toString(), `sendmsg
call-command: execute
execute-app-name: hangup

`)
})

Deno.test('sendmsg with arg', async () => {
    const out = new StringWriter()
    
    await Pdu.writeTo({command: 'execute', app: 'playback', arg: '/tmp/test.ogg'}, out)
    assertEquals(out.toString(), `sendmsg
call-command: execute
execute-app-name: playback
execute-app-arg: /tmp/test.ogg

`)
})
