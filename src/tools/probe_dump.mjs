// 探针 v3：抓 modded_network_setup_failed 的原始载荷并尝试解码。
// 这个包是服务器"告诉你缺什么"的唯一渠道，是学习器路线的输入源。
import fs from 'node:fs'
import mc from 'minecraft-protocol'

const host = process.argv[2] || 'mc.example.com'
const port = parseInt(process.argv[3] || '25565', 10)
const username = process.argv[4] || 'probe_bot'

const client = mc.createClient({ host, port, username, auth: 'offline', version: '1.21.1' })
let replied = false

function readVarInt(buf, off) {
  let num = 0, shift = 0, bytes = 0
  while (true) {
    if (off + bytes >= buf.length) return [null, off + bytes]
    const b = buf[off + bytes]
    num |= (b & 0x7f) << shift
    bytes++
    if (!(b & 0x80)) return [num >>> 0, off + bytes]
    shift += 7
    if (bytes > 5) return [null, off + bytes]
  }
}

client.on('packet', (data, meta) => {
  if (meta.name === 'custom_payload') {
    if (data.channel === 'neoforge:register' && !replied) {
      replied = true
      client.write('custom_payload', { channel: 'neoforge:register', data: Buffer.from([0]) })
      client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.alloc(0) })
      return
    }
    if (data.channel === 'neoforge:modded_network_setup_failed') {
      const buf = Buffer.from(data.data)
      fs.writeFileSync('setup_failed.bin', buf)
      console.log(`\n[抓到] modded_network_setup_failed  长度=${buf.length}B 已存 setup_failed.bin`)
      console.log('--- HEX（前 320B）---')
      console.log(buf.subarray(0, 320).toString('hex').replace(/(.{64})/g, '$1\n'))
      console.log('\n--- 结构尝试：varint 序列 + 字符串 ---')
      let off = 0
      const [n1, o1] = readVarInt(buf, off)
      console.log(`varint@0 = ${n1}`)
      off = o1
      // 尝试按 writeUtf 读一串字符串
      const strs = []
      let guard = 0
      while (off < buf.length && guard++ < 400) {
        const [len, o2] = readVarInt(buf, off)
        if (len === null || len <= 0 || len > 300) break
        if (o2 + len > buf.length) break
        const s = buf.subarray(o2, o2 + len).toString('utf8')
        if (!/^[\x20-\x7e]+$/.test(s)) break
        strs.push(s)
        off = o2 + len
      }
      console.log(`可读字符串 ${strs.length} 条：`)
      strs.slice(0, 40).forEach((s) => console.log('  ' + s))
      console.log('\n--- 原文可打印片段 ---')
      const printable = buf.toString('latin1').replace(/[^\x20-\x7e]+/g, '\n').split('\n').filter((x) => x.length > 3)
      printable.slice(0, 40).forEach((s) => console.log('  ' + s.slice(0, 120)))
      process.exit(0)
    }
  }
  if (/disconnect/i.test(meta.name)) {
    console.log(`[踢] ${JSON.stringify(data).slice(0, 300)}`)
  }
})

setTimeout(() => { console.log('20s 超时，未拿到 setup_failed'); process.exit(0) }, 20000)
