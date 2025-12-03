'use strict'

const net = require('net')
const tap = require('tap')
const vasync = require('vasync')
const vm = require('node:vm')
const { getSock } = require('./utils')
const ldap = require('../lib')

const SERVER_PORT = process.env.SERVER_PORT || 1389
const SUFFIX = 'dc=test'

tap.beforeEach(function (t) {
  // We do not need a `.afterEach` to clean up the sock files because that
  // is done when the server is destroyed.
  t.context.sock = getSock()
})

tap.test('basic create', function (t) {
  const server = ldap.createServer()
  t.ok(server)
  t.end()
})

tap.test('connection count', function (t) {
  const server = ldap.createServer()
  t.ok(server)
  server.listen(0, '127.0.0.1', function () {
    t.ok(true, 'server listening on ' + server.url)

    server.getConnections(function (err, count) {
      t.error(err)
      t.equal(count, 0)

      const client = ldap.createClient({ url: server.url })
      client.on('connect', function () {
        t.ok(true, 'client connected')
        server.getConnections(function (err, count) {
          t.error(err)
          t.equal(count, 1)
          client.unbind()
          server.close(() => t.end())
        })
      })
    })
  })
})

tap.test('properties', function (t) {
  const server = ldap.createServer()
  t.equal(server.name, 'LDAPServer')

  // TODO: better test
  server.maxConnections = 10
  t.equal(server.maxConnections, 10)

  t.equal(server.url, null, 'url empty before bind')
  // listen on a random port so we have a url
  server.listen(0, '127.0.0.1', function () {
    t.ok(server.url)

    server.close(() => t.end())
  })
})

tap.test('IPv6 URL is formatted correctly', function (t) {
  const server = ldap.createServer()
  t.equal(server.url, null, 'url empty before bind')
  server.listen(0, '::1', function () {
    t.ok(server.url)
    t.equal(server.url, 'ldap://[::1]:' + server.port)

    server.close(() => t.end())
  })
})

tap.test('listen on unix/named socket', function (t) {
  const server = ldap.createServer()
  server.listen(t.context.sock, function () {
    t.ok(server.url)
    t.equal(server.url.split(':')[0], 'ldapi')
    server.close(() => t.end())
  })
})

tap.test('listen on static port', function (t) {
  const server = ldap.createServer()
  server.listen(SERVER_PORT, '127.0.0.1', function () {
    const addr = server.address()
    t.equal(addr.port, parseInt(SERVER_PORT, 10))
    t.equal(server.url, `ldap://127.0.0.1:${SERVER_PORT}`)
    server.close(() => t.end())
  })
})

tap.test('listen on ephemeral port', function (t) {
  const server = ldap.createServer()
  server.listen(0, '127.0.0.1', function () {
    const addr = server.address()
    t.ok(addr.port > 0)
    t.ok(addr.port < 65535)
    server.close(() => t.end())
  })
})

tap.test('route order', function (t) {
  function generateHandler (response) {
    const func = function handler (req, res, next) {
      res.send({
        dn: response,
        attributes: { }
      })
      res.end()
      return next()
    }
    return func
  }

  const server = ldap.createServer()
  const sock = t.context.sock
  const dnShort = SUFFIX
  const dnMed = 'dc=sub,' + SUFFIX
  const dnLong = 'dc=long,dc=sub,' + SUFFIX

  // Mount routes out of order
  server.search(dnMed, generateHandler(dnMed))
  server.search(dnShort, generateHandler(dnShort))
  server.search(dnLong, generateHandler(dnLong))
  server.listen(sock, function () {
    t.ok(true, 'server listen')
    const client = ldap.createClient({ socketPath: sock })
    client.on('connect', () => {
      vasync.forEachParallel({
        func: runSearch,
        inputs: [dnShort, dnMed, dnLong]
      }, function (err) {
        t.error(err)
        client.unbind()
        server.close(() => t.end())
      })
    })

    function runSearch (value, cb) {
      client.search(value, '(objectclass=*)', function (err, res) {
        t.error(err)
        t.ok(res)
        res.on('searchEntry', function (entry) {
          t.equal(entry.dn.toString(), value)
        })
        res.on('end', function () {
          cb()
        })
      })
    }
  })
})

tap.test('route absent', function (t) {
  const server = ldap.createServer()
  const DN_ROUTE = 'dc=base'
  const DN_MISSING = 'dc=absent'

  server.bind(DN_ROUTE, function (req, res, next) {
    res.end()
    return next()
  })

  server.listen(t.context.sock, function () {
    t.ok(true, 'server startup')
    vasync.parallel({
      funcs: [
        function presentBind (cb) {
          const clt = ldap.createClient({ socketPath: t.context.sock })
          clt.bind(DN_ROUTE, '', function (err) {
            t.notOk(err)
            clt.unbind()
            cb()
          })
        },
        function absentBind (cb) {
          const clt = ldap.createClient({ socketPath: t.context.sock })
          clt.bind(DN_MISSING, '', function (err) {
            t.ok(err)
            t.equal(err.code, ldap.LDAP_NO_SUCH_OBJECT)
            clt.unbind()
            cb()
          })
        }
      ]
    }, function (err) {
      t.notOk(err)
      server.close(() => t.end())
    })
  })
})

tap.test('route unbind', function (t) {
  const server = ldap.createServer()

  server.unbind(function (req, res, next) {
    t.ok(true, 'server unbind successful')
    res.end()
    return next()
  })

  server.listen(t.context.sock, function () {
    t.ok(true, 'server startup')
    const client = ldap.createClient({ socketPath: t.context.sock })
    client.bind('', '', function (err) {
      t.error(err, 'client bind error')
      client.unbind(function (err) {
        t.error(err, 'client unbind error')
        server.close(() => t.end())
      })
    })
  })
})

tap.test('bind/unbind identity anonymous', function (t) {
  const server = ldap.createServer({
    connectionRouter: function (c) {
      server.newConnection(c)
      server.emit('testconnection', c)
    }
  })

  server.unbind(function (req, res, next) {
    t.ok(true, 'server unbind successful')
    res.end()
    return next()
  })

  server.bind('', function (req, res, next) {
    t.ok(true, 'server bind successful')
    res.end()
    return next()
  })

  const anonDN = ldap.parseDN('cn=anonymous')

  server.listen(t.context.sock, function () {
    t.ok(true, 'server startup')

    const client = ldap.createClient({ socketPath: t.context.sock })
    server.once('testconnection', (c) => {
      t.ok(anonDN.equals(c.ldap.bindDN), 'pre bind dn is correct')
      client.bind('', '', function (err) {
        t.error(err, 'client anon bind error')
        t.ok(anonDN.equals(c.ldap.bindDN), 'anon bind dn is correct')
        client.unbind(function (err) {
          t.error(err, 'client anon unbind error')
          t.ok(anonDN.equals(c.ldap.bindDN), 'anon unbind dn is correct')
          server.close(() => t.end())
        })
      })
    })
  })
})

tap.test('does not crash on empty DN values', function (t) {
  const server = ldap.createServer({
    connectionRouter: function (c) {
      server.newConnection(c)
      server.emit('testconnection', c)
    }
  })

  server.listen(t.context.sock, function () {
    const client = ldap.createClient({ socketPath: t.context.sock })
    server.once('testconnection', () => {
      client.bind('', 'pw', function (err) {
        t.ok(err, 'blank bind dn throws error')
        client.unbind(function () {
          server.close(() => t.end())
        })
      })
    })
  })
})

tap.test('bind/unbind identity user', function (t) {
  const server = ldap.createServer({
    connectionRouter: function (c) {
      server.newConnection(c)
      server.emit('testconnection', c)
    }
  })

  server.unbind(function (req, res, next) {
    t.ok(true, 'server unbind successful')
    res.end()
    return next()
  })

  server.bind('', function (req, res, next) {
    t.ok(true, 'server bind successful')
    res.end()
    return next()
  })

  const anonDN = ldap.parseDN('cn=anonymous')
  const testDN = ldap.parseDN('cn=anotheruser')

  server.listen(t.context.sock, function () {
    t.ok(true, 'server startup')

    const client = ldap.createClient({ socketPath: t.context.sock })
    server.once('testconnection', (c) => {
      t.ok(anonDN.equals(c.ldap.bindDN), 'pre bind dn is correct')
      client.bind(testDN.toString(), 'somesecret', function (err) {
        t.error(err, 'user bind error')
        t.ok(testDN.equals(c.ldap.bindDN), 'user bind dn is correct')
        // check rebinds too
        client.bind('', '', function (err) {
          t.error(err, 'client anon bind error')
          t.ok(anonDN.equals(c.ldap.bindDN), 'anon bind dn is correct')
          // user rebind
          client.bind(testDN.toString(), 'somesecret', function (err) {
            t.error(err, 'user bind error')
            t.ok(testDN.equals(c.ldap.bindDN), 'user rebind dn is correct')
            client.unbind(function (err) {
              t.error(err, 'user unbind error')
              t.ok(anonDN.equals(c.ldap.bindDN), 'user unbind dn is correct')
              server.close(() => t.end())
            })
          })
        })
      })
    })
  })
})

tap.test('strict routing', function (t) {
  const testDN = 'cn=valid'
  let clt
  let server
  const sock = t.context.sock
  vasync.pipeline({
    funcs: [
      function setup (_, cb) {
        server = ldap.createServer({})
        // invalid DNs would go to default handler
        server.search('', function (req, res, next) {
          t.ok(req.dn)
          t.equal(typeof (req.dn), 'object')
          t.equal(req.dn.toString(), testDN)
          res.end()
          next()
        })
        server.listen(sock, function () {
          t.ok(true, 'server startup')
          clt = ldap.createClient({
            socketPath: sock
          })
          cb()
        })
      },
      function testGood (_, cb) {
        clt.search(testDN, { scope: 'base' }, function (err, res) {
          t.error(err)
          res.once('error', function (err2) {
            t.error(err2)
            cb(err2)
          })
          res.once('end', function (result) {
            t.ok(result, 'accepted invalid dn')
            cb()
          })
        })
      }
    ]
  }, function (err) {
    t.error(err)
    if (clt) {
      clt.destroy()
    }
    server.close(() => t.end())
  })
})

tap.test('close accept a callback', function (t) {
  const server = ldap.createServer()
  // callback is called when the server is closed
  server.listen(0, function (err) {
    t.error(err)
    server.close(function (err) {
      t.error(err)
      t.end()
    })
  })
})

tap.test('close without error calls callback', function (t) {
  const server = ldap.createServer()
  // when the server is closed without error, the callback parameter is undefined
  server.listen(1389, '127.0.0.1', function (err) {
    t.error(err)
    server.close(function (err) {
      t.error(err)
      t.end()
    })
  })
})

tap.test('close passes error to callback', function (t) {
  const server = ldap.createServer()
  // when the server is closed with an error, the error is the first parameter of the callback
  server.close(function (err) {
    t.ok(err)
    t.end()
  })
})

tap.test('multithreading support via external server', function (t) {
  const serverOptions = { }
  const server = ldap.createServer(serverOptions)
  const fauxServer = net.createServer(serverOptions, (connection) => {
    server.newConnection(connection)
  })
  fauxServer.log = serverOptions.log
  fauxServer.ldap = {
    config: serverOptions
  }
  t.ok(server)
  fauxServer.listen(5555, '127.0.0.1', function () {
    t.ok(true, 'server listening on ' + server.url)

    t.ok(fauxServer)
    const client = ldap.createClient({ url: 'ldap://127.0.0.1:5555' })
    client.on('connect', function () {
      t.ok(client)
      client.unbind()
      fauxServer.close(() => t.end())
    })
  })
})

tap.test('multithreading support via hook', function (t) {
  const serverOptions = {
    connectionRouter: (connection) => {
      server.newConnection(connection)
    }
  }
  const server = ldap.createServer(serverOptions)
  const fauxServer = ldap.createServer(serverOptions)
  t.ok(server)
  fauxServer.listen(0, '127.0.0.1', function () {
    t.ok(true, 'server listening on ' + server.url)

    t.ok(fauxServer)
    const client = ldap.createClient({ url: fauxServer.url })
    client.on('connect', function () {
      t.ok(client)
      client.unbind()
      fauxServer.close(() => t.end())
    })
  })
})

tap.test('cross-realm type checks', function (t) {
  const server = ldap.createServer()
  const ctx = vm.createContext({})
  vm.runInContext(
    'globalThis.search=function(){};\n' +
    'globalThis.searches=[function(){}];'
    , ctx)
  server.search('', ctx.search)
  server.search('', ctx.searches)
  t.ok(server)
  t.end()
})

tap.test('TLS server with cipher and version options', function (t) {
  const tls = require('tls')
  const certificate = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUCBbB+dPx8lFMmVH9S70dZRIdvbEwDQYJKoZIhvcNAQEL
BQAwMDESMBAGA1UEAwwJbG9jYWxob3N0MQ0wCwYDVQQKDARUZXN0MQswCQYDVQQG
EwJVUzAeFw0yNTEyMDMxNzE4NDNaFw0yNjEyMDMxNzE4NDNaMDAxEjAQBgNVBAMM
CWxvY2FsaG9zdDENMAsGA1UECgwEVGVzdDELMAkGA1UEBhMCVVMwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDFDiB7iwsvqeccPFHW8G5pHU4Tivdjj/TI
e+X/0IEQrZklgNw4a4idJ/bUAIwLVXowIgoXbheOtfPYXoShIxI0Z3HnpvYYTN8+
onjByAvrFPwgz+7zvyGAmobV+rkLiLN3SiorADXjr6bCvA8hORn8Y+dL1DbO6bh+
bog7LIklP5gTmq5uXL13sDkw0f3bIrhoNcZ0bBdH3YtlfMGGhoWOtUgRJs/nDeoZ
57c1g8ShotJdN5sytMHQnYFxh6PwM37vhANP/EcQDOkWmqjPkFpzw5aR0OwLR43D
gFG3ffMYiPRbWs+7nA/b+g7xJn5Wy21SiNSfrF+3X+A6tjoTPOHvAgMBAAGjUzBR
MB0GA1UdDgQWBBRoFp6qIfqdOJYHsN3KbRWl+wVzszAfBgNVHSMEGDAWgBRoFp6q
IfqdOJYHsN3KbRWl+wVzszAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQAC8HYslXuFAiVVUue97WnDZOMiwo9Jr1Pzkww4hXuM3Od/V48OUrH/4din
PX2QWf6mk48S0GhIqixsaCBszfFL2D1NF4SU7qcOfBwuxYOmpACUyRWxcTXU6aXe
P+6oRF5oWKi322S4G8pqUaD1dD2jGIaxVAJJQsBhCBqZgbeJ0rsOOV6qZng9GSJp
lCLSqJpe1BtVu84wCRE/jwd5oRumiznQMqKDSNeK4UIzSxDypQBiRziOqk6/DO64
mLKD0N6kQc23FHo31seNrTOP+dDMxRzRfh8fmv86GeZkAaVithFSJHggSm5IDQRq
F/M3HNOcy3erKP8TfYuT3yViLtDb
-----END CERTIFICATE-----`
  const key = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDFDiB7iwsvqecc
PFHW8G5pHU4Tivdjj/TIe+X/0IEQrZklgNw4a4idJ/bUAIwLVXowIgoXbheOtfPY
XoShIxI0Z3HnpvYYTN8+onjByAvrFPwgz+7zvyGAmobV+rkLiLN3SiorADXjr6bC
vA8hORn8Y+dL1DbO6bh+bog7LIklP5gTmq5uXL13sDkw0f3bIrhoNcZ0bBdH3Ytl
fMGGhoWOtUgRJs/nDeoZ57c1g8ShotJdN5sytMHQnYFxh6PwM37vhANP/EcQDOkW
mqjPkFpzw5aR0OwLR43DgFG3ffMYiPRbWs+7nA/b+g7xJn5Wy21SiNSfrF+3X+A6
tjoTPOHvAgMBAAECggEATzzUAPmzYNIwNaFnw0dhDnGTQLaDrgxoAOoZXVmJXJyB
1ZvQcfuDrrYwQaWKqtAPVyWI600AugkeaaXwLR9+JYZnPiBcGv9mUbhhWILJkBkb
HVKfonH71cvNZmPwXtv0VoaDGFF4Wfr60plueAyPD3dYvZwzAdbnsideLnVFHK2V
e/FJlny1c/gddhPfVmbsQ/0Z+V75dXNntqij1pX0dS/1BaE0E7dVN5687mI/ATGg
f0dCbg4xKK90fZFW4TYEpbHKH+hos74z0I0/Vgeshls4ma9ESws8IMXB+EDygJ/4
BeiC+ETGcNd1VCYrUD/i8meIvqxGB6RD5ZirtVogeQKBgQD0v97IfGzJHMPx/16X
0cex4DmPTDMenZejJSXR61b4EArHzVURa11fOAPkPYBxcUyqc8D2FKxMKyRenVBH
M8FtMFfLYE/tKqYQiAgk/dLI4ssIeI1hjHBIiX11RkpOa8u2GVY1F6GbQ8tTvbnZ
QOB6qRFZ+hiN0J63Inz/UP43jQKBgQDOHQGLWh6zO97jPcFo6Mf26VkEJJcETHa4
RZ7ndCflv1vmoM1Tse4aOf0xQRd38/nGuL+wet3A6ed6ifFRbGGxRHoyV//PaHev
Xu7XIsbcGoIIIVP1VHZPiIrahMbbB7zlm1DmrRy67fDodCfJIZUoyXryFOcX7q2y
l3cWRZLSawKBgQCgXyUc26LwuN+QL5QNCRG/9TviML0CX6Mf7NR2U63+B4z41Qvb
yS06mlq6cK48J1BkFEspM+yeUFqZgJ08uqYQ5O9yPR7COgLsrCYiDwvSRAFkAJIr
jDl63lSNxswjzLCEFuANE/n54hdWPOiNedxdo3DSM3VpX3zQZVHgfnLFdQKBgEae
66OKmlBBKEpmI3nFoJY6N9TSkKfZZygWOq8FPpJasatg11lg8rsruVQCAH+KKb/s
F0npn0d1HWoAD54da4+obdIIEs9G9RMyjNVLxiUuM/WDLdg2O19e4myi59uuWAu3
3s1a7SgjVNLg0az5g7j459ZAUToC/qLdgOExr2/HAoGBAO+nFISLrmT5ISKgzhyh
/1uvd7+hArFTbMOLXeJxfPwuT3R3/lrL9Mt80Yr6z8Kb7b0FWfXTAe84G3Mbalb4
0Fe8CNIgOGnTVRFcuXQlN6eZPVu8cL63jze54I6NZmro/stmlW0zsvdRKxhTIlZH
ZqidFtVna6eyDMUCj2wBHTr6
-----END PRIVATE KEY-----`

  // Test that TLS options are accepted and passed through correctly
  const server = ldap.createServer({
    certificate,
    key,
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384',
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3'
  })

  t.ok(server, 'server created successfully with TLS options')
  t.ok(server.server instanceof tls.Server, 'server is a TLS server')

  // Listen and verify the server starts correctly with TLS options
  server.listen(0, '127.0.0.1', function () {
    t.ok(server.url, 'server has URL')
    t.ok(server.url.startsWith('ldaps://'), 'server URL uses ldaps protocol')

    // Create a TLS client to connect and verify the connection works
    const tlsOptions = {
      host: '127.0.0.1',
      port: server.port,
      rejectUnauthorized: false // Self-signed cert
    }

    const client = tls.connect(tlsOptions, function () {
      t.ok(client.encrypted, 'TLS connection is encrypted')
      t.ok(client.getProtocol(), 'TLS protocol negotiated')

      // Verify protocol version is within our specified range
      const protocol = client.getProtocol()
      t.ok(
        protocol === 'TLSv1.2' || protocol === 'TLSv1.3',
        `TLS version ${protocol} is within specified range`
      )

      client.end()
      server.close(() => t.end())
    })

    client.on('error', function (err) {
      t.fail('TLS client connection error: ' + err.message)
      server.close(() => t.end())
    })
  })
})
