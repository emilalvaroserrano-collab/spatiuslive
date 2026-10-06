import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'

// Serves the product knowledge .md as the single source of truth — the
// browser appends it to Kimmy's system prompt at connect time, so editing
// the .md updates her facts without a code change.
export async function GET() {
  try {
    const file = path.join(process.cwd(), 'product-knowledge', 'coffee-luxxe.md')
    const knowledge = await readFile(file, 'utf8')
    return NextResponse.json({ knowledge })
  } catch {
    return NextResponse.json({ error: 'Product knowledge unavailable' }, { status: 500 })
  }
}
