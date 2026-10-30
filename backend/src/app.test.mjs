import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildApp } from './app.mjs'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-studio-api-'))
const app = await buildApp({
  isProduction: false,
  clientOrigin: 'http://localhost:5173',
  cookieSecret: 'test-secret-that-is-long-enough-for-cookie-signing',
  trustProxy: false,
  logLevel: 'silent',
  dataDir,
})

test.after(async () => {
  await app.close()
  await fs.rm(dataDir, { recursive: true, force: true })
})

async function csrf() {
  const response = await app.inject({ method: 'GET', url: '/api/auth/csrf' })
  return { token: response.json().token, cookie: response.headers['set-cookie'].split(';')[0] }
}

function cookieFrom(response, name) {
  const values = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie']
    : [response.headers['set-cookie']]
  return values.find((value) => value?.startsWith(`${name}=`))?.split(';')[0]
}

test('protege alterações por CSRF e isola documentos por proprietário', async () => {
  const first = await csrf()
  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { cookie: first.cookie, 'x-csrf-token': first.token },
    payload: { email: 'primeira@exemplo.com', password: 'senha forte de teste' },
  })
  assert.equal(register.statusCode, 201)
  const authCookie = cookieFrom(register, 'pdf_session')
  assert.ok(authCookie)

  const uploadCsrf = await csrf()
  const boundary = 'pdf-studio-boundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="seguro.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    Buffer.from('%PDF-1.7\ntexto de teste'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const upload = await app.inject({
    method: 'POST',
    url: '/api/documents',
    headers: {
      cookie: `${authCookie}; ${uploadCsrf.cookie}`,
      'x-csrf-token': uploadCsrf.token,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  })
  assert.equal(upload.statusCode, 201)
  const documentId = upload.json().document.id

  const saveCsrf = await csrf()
  const savedEdits = {
    1: [
      {
        id: 'f9f517e1-1455-4cad-b7a4-0875b7d2cdfc',
        x: 20,
        y: 32,
        width: 160,
        height: 30,
        text: 'Texto salvo',
        fontSize: 14,
      },
    ],
  }
  const save = await app.inject({
    method: 'PUT',
    url: `/api/documents/${documentId}/edits`,
    headers: { cookie: `${authCookie}; ${saveCsrf.cookie}`, 'x-csrf-token': saveCsrf.token },
    payload: { edits: savedEdits },
  })
  assert.equal(save.statusCode, 200)
  const reloaded = await app.inject({
    method: 'GET',
    url: `/api/documents/${documentId}`,
    headers: { cookie: authCookie },
  })
  assert.deepEqual(reloaded.json().edits, savedEdits)

  const second = await csrf()
  const secondRegister = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { cookie: second.cookie, 'x-csrf-token': second.token },
    payload: { email: 'segunda@exemplo.com', password: 'outra senha forte de teste' },
  })
  const secondAuth = cookieFrom(secondRegister, 'pdf_session')
  const forbiddenDownload = await app.inject({
    method: 'GET',
    url: `/api/documents/${documentId}/download`,
    headers: { cookie: secondAuth },
  })
  assert.equal(forbiddenDownload.statusCode, 404)

  const missingCsrf = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: authCookie } })
  assert.equal(missingCsrf.statusCode, 403)
})
