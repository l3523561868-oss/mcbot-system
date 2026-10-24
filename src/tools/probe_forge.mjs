// 探针 v2：主动回应协商，看服务器到底接受什么样的客户端。
// 思路：收到 neoforge:register 就回一个空表 + 空的 minecraft:register 监听表，
// 观察它是"直接踢"还是"给出缺什么"的提示。
//
// 用法： node probe_forge.mjs [host] [port] [username]
import mc from 'minecraft-protocol'

const host = process.argv[2] || 'mc.example.com'
const port = parseInt(process.argv[3] || '25565', 10)
const username = process.argv[4] || 'probe_bot'

const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
const seen = new Map()
let replied = false
let kicked = null

const client = mc.createClient({
  host, port, username, auth: 'offline', version: '1.21.1',
})

client.on('connect', () => console.log(`${ts()} [connect]`))
client.on('login', () => console.log(`${ts()} [login] 已登录，进入 configuration`))

client.on('packet', (data, meta) => {
  seen.set(meta.name, (seen.get(meta.name) || 0) + 1)

  if (meta.name === 'disconnect' || /disconnect/i.test(meta.name)) {
    kicked = data
    console.log(`${ts()} ★ 被踢：${JSON.stringify(data).slice(0, 600)}`)
    return
  }

  if (meta.name === 'custom_payload') {
    const ch = data.channel
    const len = data.data?.length ?? 0
    console.log(`${ts()} [in:configuration] ${ch} (${len}B)`)
    if (ch === 'neoforge:register' && !replied) {
      replied = true
      // 回一个空通道表（count=0）
      try {
        client.write('custom_payload', {
          channel: 'neoforge:register',
          data: Buffer.from([0x00]),
        })
        console.log(`${ts()} [out] neoforge:register 空表(count=0)`)
      } catch (e) {
        console.log(`${ts()} [out-fail] neoforge:register: ${e.message}`)
      }
      // 回空的监听表（零条目 = 零字节）
      try {
        client.write('custom_payload', {
          channel: 'minecraft:register',
          data: Buffer.alloc(0),
        })
        console.log(`${ts()} [out] minecraft:register 空监听表`)
      } catch (e) {
        console.log(`${ts()} [out-fail] minecraft:register: ${e.message}`)
      }
    }
  }
})

client.on('error', (e) => console.log(`${ts()} [error] ${e?.message || e}`))
client.on('end', (r) => console.log(`${ts()} [end] ${r || '(无原因)'}`))

setTimeout(() => {
  console.log('\n===== 汇总 =====')
  for (const [k, v] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${k} x${v}`)
  }
  console.log(kicked ? `踢出原因：${JSON.stringify(kicked).slice(0, 800)}` : '20s 内未踢、也未进 PLAY')
  process.exit(0)
}, 20000)
