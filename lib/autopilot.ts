// Autopilot director: keeps Kimmy talking nonstop during quiet moments.
// The browser watchdog sends one of these lines whenever Gemini has produced
// no audio for AUTOPILOT_IDLE_MS. Rotation is round-robin across categories.
//
// PRODUCT_FAQS is the only product-specific part — replace the placeholders
// with real Q&A from the catalog (or generate them from a product feed).

export const AUTOPILOT_IDLE_MS = 2_000

export const PRODUCT_FAQS: string[] = [
  'Magkano? State the exact variant prices: pouch ₱399, half-kilo tub ₱999, kilo pouch ₱1,899 — price first, then push checkout. If the yellow basket shows a different live price, quote the basket.',
  'Ano laman nito? Name the actives: hydrolyzed marine collagen, L-glutathione, L-carnitine, chitosan, inulin fiber, stevia sweetened — one benefit each, fast.',
  'Bakit decaf? No caffeine: no palpitations, no jitters, safe second cup at night. Contrast with regular coffee.',
  'Para saan to? Slimming support plus skin glow in one cup: appetite control, fat-burn support, digestion, radiant skin. Never promise guaranteed results.',
  'Paano timplahin? Hot or iced, follow the mixing directions on the pack — fully dissolve, add ice if you like. Check the label for servings per day.',
  'Acidic ba? Manufacturer markets it as non-acidic, pero tolerance varies — kung sensitive ka, start with a small cup. Medical questions go to your doctor, not to the live.',
  'Buntis, breastfeeding, may maintenance? Do not approve safety — name the listed ingredients, tell them to read the full label and ask their clinician.',
  'COD ba? Yes, cash on delivery via yellow basket. Claim vouchers before checkout. Website has free shipping on ₱1,500+ spend.',
  'Legit ba? Original Luxe Slim by Anna Magkawas, also sold in Watsons and Rose Pharmacy. No fakes here.',
  'Anong variant kunin ko? Pouch for first-timers at ₱399, half-kilo tub for daily drinkers at ₱999, kilo for the family at ₱1,899.',
]

const FOLLOW_SHARE: string[] = [
  'Ask new viewers to follow so they catch the next live and restocks.',
  'Ask viewers to share the live to their GC and tap the heart button.',
  'Thank the viewers who just followed and invite questions.',
]

const CHECKOUT: string[] = [
  'Walk them through checkout step by step: yellow basket, pick variation, place order.',
  'Push the promo: sale price plus vouchers, claim before checkout.',
  'Do a 5-4-3-2-1 checkout countdown for the current item.',
]

const ENGAGE: string[] = [
  'Ask what products they want to see next and invite comments.',
  'Answer an imaginary common question, then invite real ones.',
  'Tease the next item without revealing the price yet.',
]

const POOL: string[][] = [PRODUCT_FAQS, PRODUCT_FAQS, FOLLOW_SHARE, CHECKOUT, ENGAGE]
const cursor = [0, 0, 0, 0]
let round = 0

export function nextAutopilotLine(): string {
  const bucket = POOL[round % POOL.length]
  const line = bucket[cursor[round % POOL.length] % bucket.length]
  cursor[round % POOL.length] += 1
  round += 1
  return line
}
