import {
    assertArrayIncludes,
    assertEquals,
    assertThrows
} from 'https://deno.land/std@0.88.0/testing/asserts.ts'

import {
    StringWriter,
    Buffer,
} from "https://deno.land/std@0.93.0/io/mod.ts";

import { Message, FreeswitchOutboundTCP } from './impl.ts'

const text_encoder = new TextEncoder()

Deno.test('sendmsg without arg', async () => {
    const out = new StringWriter()
    
    await Message.writeTo(out, {command: 'execute', app: 'hangup'})
    assertEquals(out.toString(), `sendmsg
call-command: execute
execute-app-name: hangup

`)
})

Deno.test('sendmsg with arg', async () => {
    const out = new StringWriter()
    
    await Message.writeTo(out, {command: 'execute', app: 'playback', arg: '/tmp/test.ogg'})
    assertEquals(out.toString(), `sendmsg
call-command: execute
execute-app-name: playback
execute-app-arg: /tmp/test.ogg

`)
})

Deno.test('dispatch event', async () => {
    const listener = await Deno.listen({port: 9090})
   
    const tcp_conn: Deno.Conn = await Deno.connect({port: 9090})
    const conn = new FreeswitchOutboundTCP(tcp_conn)
    const event = `Content-Length: 555
Content-Type: text/event-plain

Event-Name: RE_SCHEDULE
Core-UUID: a95e64ec-df1f-48f4-acbf-34b4c359d747
FreeSWITCH-Hostname: faulty.local
FreeSWITCH-Switchname: faulty.local
FreeSWITCH-IPv4: 192.168.1.102
FreeSWITCH-IPv6: %3A%3A1
Event-Date-Local: 2015-07-04%2015%3A18%3A14
Event-Date-GMT: Sat,%2004%20Jul%202015%2018%3A18%3A14%20GMT
Event-Date-Timestamp: 1436033894106095
Event-Calling-File: switch_scheduler.c
Event-Calling-Function: switch_scheduler_execute
Event-Calling-Line-Number: 71
Event-Sequence: 1996
Task-ID: 2
Task-Desc: heartbeat
Task-Group: core
Task-Runtime: 1436033914

`
    await conn.ack()

    // simulate freeswitch event socket protocol
    const arrangeListen = new Promise(async (resolve, reject) => {
        const conn = await listener.accept()
        
        const connect = new Uint8Array(9)
        await conn.read(connect)

        const data = text_encoder.encode(event)
        const n = await conn.write(data)
        assertEquals(n, data.length)
        conn.close()
    })



    const wait_event = new Promise((resolve) => {
        conn.on_event((event: any) => {
            resolve(event)
            tcp_conn.close()
            listener.close()
        })
    })
    

    await conn.iterate()
    const expected_event: any = await wait_event
    assertEquals(expected_event['event-name'], 'RE_SCHEDULE')
})

Deno.test('dispatch event partial', async () => {
    const listener = await Deno.listen({port: 9090})
   
    const tcp_conn: Deno.Conn = await Deno.connect({port: 9090})
    const conn = new FreeswitchOutboundTCP(tcp_conn)
    const fragments = [`Content-Length: 555
Content-Type: text/event-plain

Event-Name: RE_SCHEDULE
Core-UUID: a95e64ec-df1f-48f4-acbf-34b4c359d747
FreeSWITCH-Hostname: faulty.local
FreeSWITCH-Switchname: faulty.local
FreeSWITCH-IPv4: 192.168.1.102
FreeSWITCH-IPv6: %3A%3A1`,
`Event-Date-Local: 2015-07-04%2015%3A18%3A14
Event-Date-GMT: Sat,%2004%20Jul%202015%2018%3A18%3A14%20GMT
Event-Date-Timestamp: 1436033894106095
Event-Calling-File: switch_scheduler.c
Event-Calling-Function: switch_scheduler_execute
Event-Calling-Line-Number: 71
Event-Sequence: 1996`,
`Task-ID: 2
Task-Desc: heartbeat
Task-Group: core
Task-Runtime: 1436033914

`]
    await conn.ack()
    
    // simulate freeswitch event socket protocol
    const arrangeListen = new Promise(async (resolve, reject) => {
        const conn = await listener.accept()
        
        const connect = new Uint8Array(9)
        await conn.read(connect)

        for(const fragment of fragments) {
            const data = text_encoder.encode(fragment)
            const n = await conn.write(data)
            assertEquals(n, data.length)
        }
        
        conn.close()
    })

    const wait_event = new Promise((resolve) => {
        conn.on_event((event: any) => {
            resolve(event)
            tcp_conn.close()
            listener.close()
        })
    })
    

    await conn.iterate()
    const expected_event: any = await wait_event
    assertEquals(expected_event['event-name'], 'RE_SCHEDULE')
})
