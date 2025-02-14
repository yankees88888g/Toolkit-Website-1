const emc = require('earthmc'),
      rateLimit = require('./rate-limit.ts').default,
      limiter = rateLimit({ interval: 4 * 1000 })

const getIP = req =>
    req.ip || req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.connection.remoteAddress

async function getData(param) {
    switch(param) {
        case 'serverinfo': return await emc.getServerInfo()
        default: return null
    }
}

async function serve(req, res) {
    try { await limiter.check(res, 6, getIP(req)) } 
    catch { return res.status(429).json({ error: 'Rate limit exceeded' }) }

    let { param } = req.query, out = await getData(param)   
    if (!out) return res.status(400).send(`Parameter ${param} not recognized.`)

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Accept-Encoding', 'br')
    res.setHeader('Cache-Control', `s-maxage=1, stale-while-revalidate=4`)   
    
    res.status(200).json(out)
}

export default serve