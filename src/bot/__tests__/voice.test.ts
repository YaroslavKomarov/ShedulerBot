import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// vi.hoisted ensures mockTranscribe is initialised before vi.mock factory runs
const mockTranscribe = vi.hoisted(() => vi.fn())

// Mock the openai module — getWhisperClient() does `new OpenAI(...)` internally
vi.mock('openai', () => {
  class MockOpenAI {
    audio = { transcriptions: { create: mockTranscribe } }
  }
  return { default: MockOpenAI }
})

import { transcribeVoice } from '../middleware/voice.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeFakeArrayBuffer(): ArrayBuffer {
  const buf = new ArrayBuffer(8)
  new Uint8Array(buf).set([79, 103, 103, 83, 0, 2, 0, 0]) // fake OGG header bytes
  return buf
}

function makeCtx(overrides?: Partial<{
  voice: { file_id: string }
  fromId: number
}>) {
  const defaults = {
    voice: { file_id: 'file_abc123' },
    fromId: 42,
  }
  const opts = { ...defaults, ...overrides }
  return {
    from: { id: opts.fromId },
    message: { voice: opts.voice },
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TELEGRAM_BOT_TOKEN = 'test_token'
  process.env.GROQ_API_KEY = 'test_groq_key'
  delete process.env.WHISPER_PROVIDER

  // First fetch: Telegram getFile JSON
  // Second fetch: audio file download
  mockFetch
    .mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, result: { file_path: 'voice/file_123.ogg' } }),
    })
    .mockResolvedValueOnce({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(makeFakeArrayBuffer()),
    })

  mockTranscribe.mockResolvedValue({ text: 'купить молоко' })
})

describe('transcribeVoice', () => {
  it('returns transcription text on success', async () => {
    const ctx = makeCtx()
    const result = await transcribeVoice(ctx)
    expect(result).toBe('купить молоко')
  })

  it('calls Telegram getFile API then downloads from correct URL', async () => {
    const ctx = makeCtx()
    await transcribeVoice(ctx)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.telegram.org/bottest_token/getFile?file_id=file_abc123',
    )
    expect(mockFetch.mock.calls[1][0]).toBe(
      'https://api.telegram.org/file/bottest_token/voice/file_123.ogg',
    )
  })

  it('calls audio.transcriptions.create with correct model and file', async () => {
    const ctx = makeCtx()
    await transcribeVoice(ctx)

    expect(mockTranscribe).toHaveBeenCalledOnce()
    const callArg = mockTranscribe.mock.calls[0][0]
    expect(callArg.model).toBe('whisper-large-v3') // groq provider default
    expect(callArg.file).toBeInstanceOf(File)
    expect((callArg.file as File).name).toBe('voice.ogg')
    expect((callArg.file as File).type).toBe('audio/ogg')
  })

  it('throws when getFile fetch returns non-ok status', async () => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    const ctx = makeCtx()
    await expect(transcribeVoice(ctx)).rejects.toThrow('HTTP 500')
  })

  it('throws when audio download returns non-ok status', async () => {
    mockFetch.mockReset()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ok: true, result: { file_path: 'voice/file.ogg' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
    const ctx = makeCtx()
    await expect(transcribeVoice(ctx)).rejects.toThrow('HTTP 404')
  })

  it('throws when audio.transcriptions.create throws', async () => {
    mockTranscribe.mockRejectedValue(new Error('Groq quota exceeded'))
    const ctx = makeCtx()
    await expect(transcribeVoice(ctx)).rejects.toThrow('Groq quota exceeded')
  })
})
