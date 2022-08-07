const emc = require("earthmc"), endpoint = emc.endpoint,
      modify = require("earthmc-dynmap-plus"),
      cache = require("memory-cache")

var arg = index => args[index]?.toLowerCase() ?? null,
    args = []

const rateLimit = require('./rate-limit.ts').default,
      limiter = rateLimit({ interval: 14 * 1000 })

const getIP = req =>
    req.ip || req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.connection.remoteAddress

async function serve(req, res, mapName = 'aurora') {
    try { await limiter.check(res, 26, getIP(req)) } 
    catch { return res.status(429).json({ error: 'Rate limit exceeded' }) }

    let { params } = req.query,
        map = mapName == 'nova' ? emc.Nova : emc.Aurora
        
    console.log(`Receiving ${req.method} request for ${mapName}`)

    let out = req.method == 'POST' || req.method == 'PUT'
            ? await set(map, req, params)
            : await get(params, map)

    if (!out) return res.status(404).json('Error: Unknown or invalid request!')
    switch(out) {
        case 'no-auth': return res.status(403).json("Refused to send request, invalid auth key!")
        case 'cache-miss': return res.status(503).json('Data not cached yet, try again soon.')
        case 'fetch-error': return res.status(500).json('Error fetching data, please try again.')
        default: {
            if (typeof out == 'string' && out.includes('does not exist')) res.status(404).json(out)
            else {
                res.setHeader('Content-Type', 'application/json')
                res.setHeader('Accept-Encoding', 'br, gzip')

                //let [maxage, stale] = out.currentcount ? [0, 1] : [1, 5]
                //res.setHeader('Cache-Control', `s-maxage=${maxage}, stale-while-revalidate=${stale}`)   

                res.status(200).json(out)
            }
        }
    }
}

const set = async (map, req, params) => {
    let authKey = req.headers['authorization'],
        body = req.body, [dataType] = params

    if (authKey != process.env.AUTH_KEY) return 'no-auth'
    if (!body || Object.keys(body).length < 1) return null

    let mapName = map == emc.Nova ? 'nova' : 'aurora'
    switch(dataType) {
        case 'allplayers': {
            var allPlayers = await map.getAllPlayers().catch(() => {})
            if (!allPlayers) return 'fetch-error'

            const mergeByName = (pArr, req) => pArr.map(p => ({ ...req.find(e => (e.name === p.name) && e), ...p }))
            const merged = mergeByName(allPlayers, body)

            cache.put(`${mapName}_allplayers`, merged)
            return merged
        }
        case 'alliances': {
            cache.put(`${mapName}_alliances`, body)
            return body
        }
        case 'news': {
            cache.put(`${mapName}_news`, body)
            return body
        }
        default: return null
    }
}

const get = async (params, map) => {
    args = params.slice(1)

    const [dataType] = params,
          single = arg(0), filter = arg(1)

    let mapName = map == emc.Nova ? 'nova' : 'aurora' 
    switch(dataType.toLowerCase()) {
        case 'markers': {
            let aType = validParam(filter) ?? 'mega',
                alliances = cache.get(`${mapName}_alliances`)

            if (!alliances) return 'cache-miss'
            return await modify(...[
                endpoint, mapName, 
                aType, alliances
            ]) ?? 'fetch-error'
        }
        case 'update': {
            let raw = await endpoint.playerData('aurora')
            if (raw?.updates) raw.updates = raw.updates.filter(e => e.msg != "areaupdated" && e.msg != "markerupdated") 
            else raw = 'fetch-error'

            return raw
        }
        case 'towns': {
            if (!single) return await map.getTowns()
            if (!filter) return await map.getTown(single)

            return validParam(filter) ?? await map.getJoinableNations(single)
        }
        case 'nations': {
            if (!single) return await map.getNations()
            if (!filter) return await map.getNation(single)

            return validParam(filter) ?? await map.getInvitableTowns(single, false)
        }
        case 'nearby': {
            if (args.length < 4) return 'Not enough arguments specified! Refer to the documentation.'

            let type = validParam(single)
            if (type) return type

            let inputs = [
                args[1], args[2], 
                args[3], args[4] ?? args[3]]

            switch (single) {
                case 'towns': return await map.getNearbyTowns(...inputs) 
                case 'nations': return await map.getNearbyNations(...inputs)
                case 'players':
                default: return await map.getNearbyPlayers(...inputs)
            }
        }
        case 'news': {
            console.log(`Keys: ${cache.keys().join(', ')}`)

            var news = cache.get(`${mapName}_news`)
            if (!news) return 'cache-miss'

            return !single ? news : news.all.filter(n => n.message.toLowerCase().includes(single))
        }
        case 'alliances': {
            console.log(`Keys: ${cache.keys().join(', ')}`)

            let alliances = cache.get(`${mapName}_alliances`)
            if (!alliances) return 'cache-miss'

            switch (single) {
                case "submeganations":
                case "sub": return alliances.filter(a => a.type == 'sub')
                case "meganations": 
                case "mega": return alliances.filter(a => a.type == 'mega')
                case "normal":
                case "pact": return alliances.filter(a => a.type == 'normal')
                default: return !single ? alliances : alliances.find(a => a.allianceName.toLowerCase() == single)
            }
        }
        case 'allplayers': {
            console.log(`Keys: ${cache.keys().join(', ')}`)

            var cachedPlayers = cache.get(`${mapName}_allplayers`)
            if (!cachedPlayers) return 'cache-miss'
            if (!single) return cachedPlayers

            var player = cachedPlayers.find(p => p.name.toLowerCase() == single)
            return player ?? "That player does not exist!"
        }
        case 'townless':
        case 'townlessplayers': return await map.getTownless() ?? 'fetch-error'
        case 'residents': return single ? await map.getResident(single) : await map.getResidents()
        case 'onlineplayers': return single ? await map.getOnlinePlayer(single) : await map.getOnlinePlayers(true)
        default: return `Parameter ${dataType} not recognized.`
    }
}

const validParam = param => {
    let arr = ['invitable', 'joinable', 'towns', 'nations', 'players', 'pact', 'sub', 'normal']
    return arr.includes(param) ? null : `Parameter ${param} not recognized.`
}

function runMiddleware(req, res, fn) {
    return new Promise((resolve, reject) => {
        fn(req, res, (result) => {
        if (result instanceof Error) {
            return reject(result)
        }

        return resolve(result)
        })
    })
}

export {
    serve as default,
    serve,
    runMiddleware
}