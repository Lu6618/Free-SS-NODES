async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore
  const { isLoon, isSurge, isNode } = $.env
  const internal = $arguments.internal
  const regex = $arguments.regex
  let format = '{{api.country}}'
  let url = $arguments.api || 'http://ip-api.com/json?lang=zh-CN'
  if (internal) {
    if (typeof $utils === 'undefined' || typeof $utils.geoip === 'undefined' || typeof $utils.ipaso === 'undefined') {
      $.error(`仅支持 Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App`)
      throw new Error('不支持使用内部方法获取 IP 信息')
    }
    format = '{{api.country}}'
    url = $arguments.api || 'http://checkip.amazonaws.com'
  }
  const surge_http_api = $arguments.surge_http_api
  const surge_http_api_protocol = $arguments.surge_http_api_protocol || 'http'
  const surge_http_api_key = $arguments.surge_http_api_key
  const surge_http_api_enabled = surge_http_api
  if (!surge_http_api_enabled && !isLoon && !isSurge)
    throw new Error('请使用 Loon, Surge 或配置 HTTP API')

  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const remove_failed = $arguments.remove_failed
  const remove_incompatible = $arguments.remove_incompatible
  const incompatibleEnabled = $arguments.incompatible
  const geoEnabled = $arguments.geo
  const cacheEnabled = $arguments.cache
  const cache = scriptResourceCache

  const method = $arguments.method || 'get'
  const target = isLoon ? 'Loon' : isSurge ? 'Surge' : undefined
  const concurrency = parseInt($arguments.concurrency || 10)

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  if (remove_incompatible || remove_failed) {
    proxies = proxies.filter(p => {
      if (remove_incompatible && p._incompatible) return false
      if (remove_failed && !p._geo) return false
      return true
    })
  }

  if (!geoEnabled || !incompatibleEnabled) {
    proxies = proxies.map(p => {
      if (!geoEnabled) delete p._geo
      if (!incompatibleEnabled) delete p._incompatible
      return p
    })
  }

  const nameCountMap = {}
  proxies.forEach(p => {
    const name = p.name
    if (nameCountMap[name]) {
      nameCountMap[name]++
      p.name = `${name}-${nameCountMap[name]}`
    } else {
      nameCountMap[name] = 1
    }
  })

  proxies.sort((a, b) => {
    const parseName = name => {
      const match = name.match(/^(.*?)(?:-(\d+))?$/)
      const country = match ? match[1] : name
      const index = match && match[2] ? parseInt(match[2], 10) : 1
      return { country, index }
    }
    const aParsed = parseName(a.name)
    const bParsed = parseName(b.name)
    const countryCompare = aParsed.country.localeCompare(bParsed.country, 'zh-CN')
    if (countryCompare !== 0) return countryCompare
    return aParsed.index - bParsed.index
  })

  return proxies

  async function check(proxy) {
    const id = cacheEnabled
      ? `geo:${url}:${format}:${regex}:${internal}:${JSON.stringify(
          Object.fromEntries(Object.entries(proxy).filter(([key]) => !/^(collectionName|subName|id|_.*)$/i.test(key)))
        )}`
      : undefined
    try {
      const node = ProxyUtils.produce([proxy], surge_http_api_enabled ? 'Surge' : target)
      if (node) {
        const cached = cache.get(id)
        if (cacheEnabled && cached) {
          if (cached.api) {
            $.info(`[${proxy.name}] 使用成功缓存`)
            proxy.name = formatter({ proxy, api: cached.api, format, regex })
            proxy._geo = cached.api
            return
          } else {
            if (!disableFailedCache) return
          }
        }
        const startedAt = Date.now()
        const res = await http({
          method,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          },
          url,
          'policy-descriptor': node,
          node,
        })
        let api = String(lodash_get(res, 'body'))
        const status = parseInt(res.status || res.statusCode || 200)
        $.info(`[${proxy.name}] status: ${status}, latency: ${Date.now() - startedAt}`)
        if (internal) {
          const ip = api.trim()
          api = {
            countryCode: $utils.geoip(ip) || '',
            aso: $utils.ipaso(ip) || '',
            asn: $utils.ipasn(ip) || '',
          }
        } else {
          try {
            api = JSON.parse(api)
          } catch {}
        }
        $.log(`[${proxy.name}] api: ${JSON.stringify(api)}`)
        if (status === 200) {
          proxy.name = formatter({ proxy, api, format, regex })
          proxy._geo = api
          if (cacheEnabled) cache.set(id, { api })
        } else {
          if (cacheEnabled) cache.set(id, {})
        }
      } else {
        proxy._incompatible = true
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (cacheEnabled) cache.set(id, {})
    }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || 'get'
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)
    let count = 0
    const fn = async () => {
      try {
        if (surge_http_api_enabled) {
          const res = await $.http.post({
            url: `${surge_http_api_protocol}://${surge_http_api}/v1/scripting/evaluate`,
            timeout: TIMEOUT,
            headers: { 'x-key': surge_http_api_key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              script_text: `$httpClient.get(${JSON.stringify({ ...opt, timeout: TIMEOUT / 1000 })}, (error, response, data) => {  $done({ error, response, data }) }) `,
              mock_type: 'cron',
              timeout: TIMEOUT / 1000,
            }),
          })
          let body = String(lodash_get(res, 'body'))
          try {
            body = JSON.parse(body)
          } catch {}
          const error = lodash_get(body, 'result.error')
          if (error) throw new Error(error)
          let data = String(lodash_get(body, 'result.data'))
          let response = String(lodash_get(body, 'result.response'))
          return { ...response, body: data }
        } else {
          return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
        }
      } catch (e) {
        if (count < RETRIES) {
          count++
          await $.wait(RETRY_DELAY * count)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function lodash_get(source, path, defaultValue = undefined) {
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.')
    let result = source
    for (const p of paths) {
      result = Object(result)[p]
      if (result === undefined) return defaultValue
    }
    return result
  }

  function formatter({ proxy = {}, api = {}, format = '', regex = '' }) {
    if (regex) {
      const regexPairs = regex.split(/\s*;\s*/g).filter(Boolean)
      const extracted = {}
      for (const pair of regexPairs) {
        const [key, pattern] = pair.split(/\s*:\s*/g).map(s => s.trim())
        if (key && pattern) {
          try {
            const reg = new RegExp(pattern)
            extracted[key] = (typeof api === 'string' ? api : JSON.stringify(api)).match(reg)?.[1]?.trim()
          } catch (e) {
            $.error(`正则表达式解析错误: ${e.message}`)
          }
        }
      }
      api = { ...api, ...extracted }
    }
    let f = format.replace(/\{\{(.*?)\}\}/g, '${$1}')
    return eval(`\`${f}\``)
  }

  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        const results = []
        let index = 0
        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++
            currentTask()
              .then(data => {
                if (result) results[taskIndex] = wrap ? { data } : data
              })
              .catch(error => {
                if (result) results[taskIndex] = wrap ? { error } : error
              })
              .finally(() => {
                running--
                executeNextTask()
              })
          }
          if (running === 0) resolve(result ? results : undefined)
        }
        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
 