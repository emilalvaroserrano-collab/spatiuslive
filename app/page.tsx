'use client'

import dynamic from 'next/dynamic'

const KimmyAvatar = dynamic(() => import('@/components/KimmyAvatar'), {
  ssr: false,
  loading: () => <main className="boot">Loading Kimmy…</main>,
})

export default function Home() {
  return <KimmyAvatar />
}
