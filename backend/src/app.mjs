import argon2 from 'argon2'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import csrf from '@fastify/csrf-protection'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { openDatabase } from './db.mjs'

const MAX_PDF_BYTES = 25 * 1024 * 1024
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const MAX_ACTIVE_SESSIONS = 5

const credentialsSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(12).max(128),
  })
  .strict()

const overlaySchema = z
  .object({
    id: z.string().uuid(),
    x: z.number().finite().min(0).max(10000),
    y: z.number().finite().min(0).max(10000),
    width: z.number().finite().min(1).max(10000),
    height: z.number().finite().min(1).max(10000),
    text: z.string().max(5000),
    fontSize: z.number().finite().min(4).max(144),
  })
  .strict()
const editsSchema = z
  .object({
    edits: z.record(z.string().regex(/^[1-9]\d{0,3}$/), z.array(overlaySchema).max(100)),
  })
  .strict()
  .refine(({ edits }) => Object.keys(edits).length <= 1000, 'Muitas páginas alteradas.')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sessionToken = () => randomBytes(48).toString('base64url')
const publicUser = (user) => ({ id: user.id, email: user.email, createdAt: new Date(user.created_at).toISOString() })
const documentDto = (document) => ({
  id: document.id,
  name: document.original_name,
  sizeBytes: document.size_bytes,
  createdAt: new Date(document.created_at).toISOString(),
  updatedAt: new Date(document.updated_at).toISOString(),
})

function normalizeEmail(value) {
  return value.trim().toLocaleLowerCase('en-US')
}

function safeFileName(value) {
  const name = (value || 'documento.pdf')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return name || 'documento.pdf'
}

function contentDisposition(fileName) {
  const fallback = 'documento.pdf'
  const encoded = encodeURIComponent(fileName).replace(
    /['()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function hasPdfSignature(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 1024)).indexOf(Buffer.from('%PDF-')) !== -1
}

export async function buildApp(config) {
  const db = openDatabase(config.dataDir)
  const uploadsDir = path.join(config.dataDir, 'uploads')
  await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 })
  await fs.chmod(uploadsDir, 0o700)
  // Mantém o custo de uma tentativa inválida próximo ao de uma conta existente,
  // reduzindo a possibilidade de enumerar e-mails por tempo de resposta.
  const dummyPasswordHash = await argon2.hash(randomBytes(32).toString('base64url'), {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  })

  const app = Fastify({
    logger: {
      level: config.logLevel ?? (config.isProduction ? 'info' : 'warn'),
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password'],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  })
  app.decorateRequest('user', null)

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
  await app.register(cookie, { secret: config.cookieSecret, hook: 'onRequest' })
  await app.register(cors, {
    origin: config.clientOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  })
  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    ban: 2,
    errorResponseBuilder: () => ({ error: 'Muitas tentativas. Aguarde um minuto e tente novamente.' }),
  })
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_PDF_BYTES, fields: 0, parts: 1, headerPairs: 50 },
  })
  await app.register(csrf, {
    cookieKey: config.isProduction ? '__Host-pdf_csrf' : 'pdf_csrf',
    cookieOpts: { signed: true, httpOnly: true, secure: config.isProduction, sameSite: 'strict', path: '/' },
    getToken: (request) => request.headers['x-csrf-token'],
  })

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
  })

  const sessionCookie = config.isProduction ? '__Host-pdf_session' : 'pdf_session'
  const sessionCookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  }
  const clearSession = (reply) =>
    reply.clearCookie(sessionCookie, { path: '/', secure: config.isProduction, sameSite: 'strict', httpOnly: true })

  const issueSession = (reply, userId) => {
    const token = sessionToken()
    const now = Date.now()
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(),
      userId,
      sha256(token),
      now,
      now + SESSION_TTL_MS,
    )
    db.prepare(
      `DELETE FROM sessions WHERE user_id = ? AND id NOT IN (
      SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    )`,
    ).run(userId, userId, MAX_ACTIVE_SESSIONS)
    reply.setCookie(sessionCookie, token, sessionCookieOptions)
  }

  const requireAuth = async (request, reply) => {
    const token = request.cookies[sessionCookie]
    if (!token || token.length > 128) {
      clearSession(reply)
      return reply.code(401).send({ error: 'Autenticação obrigatória.' })
    }
    const session = db
      .prepare(
        `SELECT users.id, users.email, users.created_at, sessions.id AS session_id
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .get(sha256(token), Date.now())
    if (!session) {
      clearSession(reply)
      return reply.code(401).send({ error: 'Autenticação obrigatória.' })
    }
    request.user = session
  }

  // O hook do plugin usa a assinatura callback (request, reply, done); passe-o
  // diretamente ao Fastify para preservar essa assinatura.
  const csrfProtection = app.csrfProtection

  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/api/auth/csrf', async (_request, reply) => ({ token: await reply.generateCsrf() }))

  app.post(
    '/api/auth/register',
    {
      preHandler: [csrfProtection],
      config: { rateLimit: { max: 5, timeWindow: '15 minutes', ban: 0 } },
    },
    async (request, reply) => {
      const parsed = credentialsSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'E-mail ou senha inválidos.' })
      const email = normalizeEmail(parsed.data.email)
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
      if (existing) return reply.code(409).send({ error: 'Não foi possível criar a conta com estes dados.' })

      const user = {
        id: randomUUID(),
        email,
        passwordHash: await argon2.hash(parsed.data.password, {
          type: argon2.argon2id,
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1,
          hashLength: 32,
        }),
        createdAt: Date.now(),
      }
      try {
        db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
          user.id,
          user.email,
          user.passwordHash,
          user.createdAt,
        )
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE')
          return reply.code(409).send({ error: 'Não foi possível criar a conta com estes dados.' })
        throw error
      }
      issueSession(reply, user.id)
      return reply
        .code(201)
        .send({ user: { id: user.id, email: user.email, createdAt: new Date(user.createdAt).toISOString() } })
    },
  )

  app.post(
    '/api/auth/login',
    {
      preHandler: [csrfProtection],
      config: { rateLimit: { max: 5, timeWindow: '15 minutes', ban: 0 } },
    },
    async (request, reply) => {
      const parsed = credentialsSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(401).send({ error: 'E-mail ou senha incorretos.' })
      const email = normalizeEmail(parsed.data.email)
      const user = db.prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?').get(email)
      const valid = await argon2.verify(user?.password_hash ?? dummyPasswordHash, parsed.data.password)
      if (!valid) return reply.code(401).send({ error: 'E-mail ou senha incorretos.' })
      issueSession(reply, user.id)
      return { user: publicUser(user) }
    },
  )

  app.post('/api/auth/logout', { preHandler: [csrfProtection, requireAuth] }, async (request, reply) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(request.user.session_id)
    clearSession(reply)
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request) => ({ user: publicUser(request.user) }))

  app.get('/api/documents', { preHandler: [requireAuth] }, async (request) => {
    const documents = db
      .prepare(
        `SELECT id, original_name, size_bytes, created_at, updated_at
      FROM documents WHERE owner_id = ? ORDER BY updated_at DESC`,
      )
      .all(request.user.id)
    return { documents: documents.map(documentDto) }
  })

  app.post('/api/documents', { preHandler: [csrfProtection, requireAuth] }, async (request, reply) => {
    const upload = await request.file()
    if (!upload || upload.fieldname !== 'file' || upload.mimetype !== 'application/pdf') {
      return reply.code(400).send({ error: 'Envie um único arquivo PDF no campo file.' })
    }
    const buffer = await upload.toBuffer()
    if (!buffer.length || !hasPdfSignature(buffer)) {
      return reply.code(400).send({ error: 'O arquivo não contém um PDF válido.' })
    }
    const id = randomUUID()
    const storageName = `${id}.pdf`
    const document = {
      id,
      ownerId: request.user.id,
      originalName: safeFileName(upload.filename),
      storageName,
      size: buffer.length,
      createdAt: Date.now(),
    }
    const storagePath = path.join(uploadsDir, storageName)
    await fs.writeFile(storagePath, buffer, { mode: 0o600, flag: 'wx' })
    try {
      db.prepare(
        `INSERT INTO documents (id, owner_id, original_name, storage_name, size_bytes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        document.id,
        document.ownerId,
        document.originalName,
        document.storageName,
        document.size,
        document.createdAt,
        document.createdAt,
      )
    } catch (error) {
      await fs.unlink(storagePath).catch(() => {})
      throw error
    }
    return reply
      .code(201)
      .send({
        document: documentDto({
          original_name: document.originalName,
          size_bytes: document.size,
          created_at: document.createdAt,
          updated_at: document.createdAt,
          id,
        }),
      })
  })

  const findOwnedDocument = (id, ownerId) =>
    db
      .prepare(
        `SELECT id, owner_id, original_name, storage_name, size_bytes, edits_json, created_at, updated_at
    FROM documents WHERE id = ? AND owner_id = ?`,
      )
      .get(id, ownerId)

  app.get('/api/documents/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const document = findOwnedDocument(request.params.id, request.user.id)
    if (!document) return reply.code(404).send({ error: 'Documento não encontrado.' })
    try {
      return { document: documentDto(document), edits: JSON.parse(document.edits_json) }
    } catch {
      app.log.error({ documentId: document.id }, 'Invalid edits JSON')
      return reply.code(500).send({ error: 'Não foi possível abrir as alterações deste documento.' })
    }
  })

  app.put(
    '/api/documents/:id/edits',
    {
      preHandler: [csrfProtection, requireAuth],
      bodyLimit: 512 * 1024,
    },
    async (request, reply) => {
      const parsed = editsSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'As alterações enviadas são inválidas.' })
      const document = findOwnedDocument(request.params.id, request.user.id)
      if (!document) return reply.code(404).send({ error: 'Documento não encontrado.' })
      const updatedAt = Date.now()
      db.prepare('UPDATE documents SET edits_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(
        JSON.stringify(parsed.data.edits),
        updatedAt,
        document.id,
        request.user.id,
      )
      return { edits: parsed.data.edits, updatedAt: new Date(updatedAt).toISOString() }
    },
  )

  app.get('/api/documents/:id/download', { preHandler: [requireAuth] }, async (request, reply) => {
    const document = findOwnedDocument(request.params.id, request.user.id)
    if (!document) return reply.code(404).send({ error: 'Documento não encontrado.' })
    try {
      const file = await fs.readFile(path.join(uploadsDir, document.storage_name))
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', contentDisposition(document.original_name))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
      return reply.send(file)
    } catch (error) {
      if (error.code === 'ENOENT') return reply.code(404).send({ error: 'Documento não encontrado.' })
      throw error
    }
  })

  app.delete('/api/documents/:id', { preHandler: [csrfProtection, requireAuth] }, async (request, reply) => {
    const document = findOwnedDocument(request.params.id, request.user.id)
    if (!document) return reply.code(404).send({ error: 'Documento não encontrado.' })
    try {
      await fs.unlink(path.join(uploadsDir, document.storage_name))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    db.prepare('DELETE FROM documents WHERE id = ? AND owner_id = ?').run(document.id, request.user.id)
    return reply.code(204).send()
  })

  app.setNotFoundHandler({ preHandler: app.rateLimit({ max: 30, timeWindow: '1 minute' }) }, (_request, reply) => {
    reply.code(404).send({ error: 'Rota não encontrada.' })
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error.code === 'FST_CSRF_INVALID_TOKEN')
      return reply.code(403).send({ error: 'Token de segurança inválido ou expirado.' })
    if (error.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.code(413).send({ error: 'O PDF deve ter no máximo 25 MB.' })
    if (error.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE')
      return reply.code(415).send({ error: 'Envie o arquivo como multipart/form-data.' })
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: 'Requisição inválida.' })
    app.log.error(error)
    return reply.code(500).send({ error: 'Não foi possível concluir a operação.' })
  })

  app.addHook('onClose', async () => db.close())
  return app
}
