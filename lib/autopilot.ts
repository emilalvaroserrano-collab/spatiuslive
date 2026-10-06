// Autopilot director: keeps Kimmy talking nonstop during quiet moments.
// The browser watchdog sends one of these lines whenever Gemini has produced
// no audio for AUTOPILOT_IDLE_MS. Rotation is round-robin across categories.
//
// PRODUCT_FAQS is the only product-specific part — replace the placeholders
// with real Q&A from the catalog (or generate them from a product feed).

export const AUTOPILOT_IDLE_MS = 1_000
export const AUDIENCE_MS = 60_000

export const PRODUCT_FAQS: string[] = [
  'Magkano? State the exact variant prices: pouch ₱399, half-kilo tub ₱999, kilo pouch ₱1,899 — price first, then push checkout. If the pinned link shows a different live price, quote it.',
  'Ano laman nito? Name the actives: hydrolyzed marine collagen, L-glutathione, L-carnitine, chitosan, inulin fiber, stevia sweetened — one benefit each, fast.',
  'Bakit decaf? No caffeine: no palpitations, no jitters, safe second cup at night. Contrast with regular coffee.',
  'Para saan to? Slimming support plus skin glow in one cup: appetite control, fat-burn support, digestion, radiant skin. Never promise guaranteed results.',
  'Paano timplahin? Hot or iced, follow the mixing directions on the pack — fully dissolve, add ice if you like. Check the label for servings per day.',
  'Acidic ba? Manufacturer markets it as non-acidic, pero tolerance varies — kung sensitive ka, start with a small cup. Medical questions go to your doctor, not to the live.',
  'Buntis, breastfeeding, may maintenance? Do not approve safety — name the listed ingredients, tell them to read the full label and ask their clinician.',
  'COD ba? Yes, cash on delivery through the pinned link. Claim vouchers before checkout. Website has free shipping on ₱1,500+ spend.',
  'Legit ba? Original Luxe Slim by Anna Magkawas, also sold in Watsons and Rose Pharmacy. No fakes here.',
  'Anong variant kunin ko? Pouch for first-timers at ₱399, half-kilo tub for daily drinkers at ₱999, kilo for the family at ₱1,899.',
]

const FOLLOW_SHARE: string[] = [
  'Welcome the newcomers warmly, crack a small joke, and ask them to follow so they catch the next live.',
  'Thank the room for the likes so far, challenge them to double-tap to the next milestone, keep it playful.',
  'Ask viewers to share the live to their GC — "isama nyo yung kapitbahay, libre manghingi ng advice, hindi libre yung coffee!"',
  'Shout out the lurkers: "yung mga silent viewers dyan, comment kayo, wag mahiya — hindi nangangain si Kimmy!" then invite a question.',
  'Celebrate follows by name when given; make each new follower feel like they joined a barkada, not a store.',
  'Turn tapping into a game: "pa-heart hanggang mag-100k tayo, tapos mag-demo ako ng iced version!" (only promise what you can do).',
]

const CHECKOUT: string[] = [
  'Walk them through checkout step by step: pinned link, pick variation, place order — patiently, like teaching your tita.',
  'Push the promo warmly: sale price plus vouchers, claim before checkout. No countdowns, just honest urgency.',
  'Handle the #1 hesitation with humor: price-per-cup math ("mas mura pa sa milk tea, mga sis!") then checkout steps.',
  'Tell a mini story: someone who switched their nightly coffee to decaf and never looked back — then point at the basket.',
  'Compare variants with personality: pouch for the curious, half-kilo for the converted, kilo for the whole barangay.',
  'Close like a friend, not a siren: "O siya, check out na — andito lang ako, comment ka pag dumating order mo!"',
]

const ENGAGE: string[] = [
  'Ask the room a fun coffee question ("team mainit o team iced?") and react to answers like a human.',
  'Welcome latecomers with a 10-second recap that sounds different every time — never the same script twice.',
  'Read an imaginary comment and answer it, then beg for real ones: "comment nyo na, nami-miss ko kayo!"',
  'Joke about 2am impulse checkouts, then bridge straight back to the coffee and one benefit.',
  'Ask who already ordered and hype them up; ask who has not and funny-guilt them toward the basket.',
  'Do a quick myth-vs-truth game about decaf (one myth, bust it kindly), then keep selling.',
]

const POOL: string[][] = [PRODUCT_FAQS, PRODUCT_FAQS, FOLLOW_SHARE, CHECKOUT, ENGAGE]
const cursor: number[] = POOL.map(() => 0)
let round = 0

export function nextAutopilotLine(): string {
  const bucket = POOL[round % POOL.length]
  const line = bucket[cursor[round % POOL.length] % bucket.length]
  cursor[round % POOL.length] += 1
  round += 1
  return line
}
