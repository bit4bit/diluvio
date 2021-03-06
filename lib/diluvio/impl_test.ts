import {
    assertArrayIncludes,
    assertEquals,
    assertThrows
} from 'https://deno.land/std@0.88.0/testing/asserts.ts'

import {
    StringWriter,
    Buffer,
} from "https://deno.land/std@0.93.0/io/mod.ts";

import {
    TextProtoReader
} from 'https://deno.land/std@0.93.0/textproto/mod.ts'

import { Message, FreeswitchOutboundTCP, FreeswitchCallbackType } from './impl.ts'

import { text_encoder } from '../deps.ts'


interface FreeswitchCommandReply {
    command: string
    arg: string | null
    reply: string
}

class FreeswitchOutboundServerFake {
    private data: Array<string> = []
    private replies_command: Array<FreeswitchCommandReply> = []

    add_data(data: string) {
        this.data.push(data)
    }

    add_reply_command(cmd: string, arg: string | null, reply: string) {
        this.replies_command.push({command: cmd, arg: arg, reply: reply})
    }
    
    static listen(port: number) {
        const srv = new FreeswitchOutboundServerFake()
        // metodos estaticos pueden acceder a privados :)
        srv.do_listen(port)
        return srv
    }
    
    private async do_listen(port: number) {
        const listener = await Deno.listen({port: port})
        const conn = await listener.accept()

        await this.syn(conn)
        
        for(const data of this.data) {
            const enc = text_encoder.encode(data)
            await conn.write(enc)
        }

        conn.close()
        listener.close()
    }

    private async syn(conn: Deno.Conn) {
        const connect = new Uint8Array(9)
        await conn.read(connect)
    }
}

Deno.test('sendmsg without arg', async () => {
    const out = new StringWriter()
    
    await Message.writeTo(out, {command: 'execute', app: 'hangup', lock: false, event_uuid: null})
    assertEquals(out.toString(), `sendmsg
call-command: execute
execute-app-name: hangup
event-lock: false

`)
})

Deno.test('sendmsg with arg', async () => {
    const out = new StringWriter()
    
    await Message.writeTo(out, {command: 'execute', app: 'playback', arg: '/tmp/test.ogg', lock: true, event_uuid: null})
    assertEquals(out.toString(), `sendmsg
call-command: execute
execute-app-name: playback
execute-app-arg: /tmp/test.ogg
event-lock: true

`)
})

Deno.test('sendmsg with custom event uuid', async () => {
    const out = new StringWriter()
    
    await Message.writeTo(out, {command: 'execute', app: 'hangup', lock: false, event_uuid: '2323'})
    assertEquals(out.toString(), `sendmsg
call-command: execute
execute-app-name: hangup
event-lock: false
Event-UUID: 2323

`)
})

Deno.test('dispatch event', async () => {
    // simulate freeswitch event socket protocol
    const fakefs = FreeswitchOutboundServerFake.listen(9090)

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
    fakefs.add_data(event)
    
    await conn.ack()


    const wait_event = new Promise((resolve) => {
        conn.on(FreeswitchCallbackType.Event, (event: any) => {
            resolve(event)
            tcp_conn.close()
        })
    })
    

    await conn.iterate()
    const expected_event: any = await wait_event
    assertEquals(expected_event['event-name'], 'RE_SCHEDULE')
})

Deno.test('dispatch event partial', async () => {
    // simulate freeswitch event socket protocol
    const fakefs = FreeswitchOutboundServerFake.listen(9090)
   
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
    for(const fragment of fragments) {
        fakefs.add_data(fragment)
    }

    await conn.ack()
    
    const wait_event = new Promise((resolve) => {
        conn.on(FreeswitchCallbackType.Event, (event: any) => {
            resolve(event)
            tcp_conn.close()
        })
    })
    

    await conn.iterate()
    const expected_event: any = await wait_event
    assertEquals(expected_event['event-name'], 'RE_SCHEDULE')
})

/*
Deno.test('dispatch comman/reply', async () => {
    const fakefs = FreeswitchOutboundServerFake.listen(9090)
    const tcp_conn: Deno.Conn = await Deno.connect({port: 9090})
    const conn = new FreeswitchOutboundTCP(tcp_conn)

    fakefs.add_reply_command('uptime', '9999')
    
    await conn.ack()

    resp = await conn.execute('uptime')
    await conn.iterate()

    assertEquals(resp.reply, '9999')
})*/
