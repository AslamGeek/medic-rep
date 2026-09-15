const key = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const formAliases = {
  tab: 'tabs', tablet: 'tabs', tablets: 'tabs',
  syrup: 'syr', syrups: 'syr',
  injection: 'inj', injections: 'inj',
  suspension: 'susp', suspensions: 'susp',
  cap: 'caps', capsule: 'caps', capsules: 'caps',
  sachet: 'sac', sachets: 'sac',
  'skin cream': 'cream', creams: 'cream',
  drop: 'drops',
}
const formKey = (value) => formAliases[key(value)] || key(value)
const unique = (values) => [...new Map(values.filter(Boolean).map((value) => [key(value), value])).values()]

export function resolveProductReference(reference, products) {
  const value = key(reference)
  const byId = products.find((product) => key(product.prodId) === value)
  if (byId) return byId.prodId
  const label = String(reference).trim().match(/^(.*)\(([^()]*)\)$/)
  const matches = products.filter((product) => label
    ? key(product.name) === key(label[1]) && formKey(product.dosageForm) === formKey(label[2])
    : key(product.name) === value)
  // Do not guess between two variants with the same name or equivalent label.
  return matches.length === 1 ? matches[0].prodId : String(reference).trim()
}

export function productReferences(value, products) {
  if (Array.isArray(value)) return unique(value.map((item) => String(item).trim()))
  let text = String(value ?? '').trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return productReferences(parsed, products)
    } catch { /* Legacy cells can contain text beginning with a bracket. */ }
  }
  // Recognize catalog names before splitting: product names can contain commas.
  const patterns = products.map((product) => product.name.trim())
    .filter(Boolean).sort((a, b) => b.length - a.length)
    .map((name) => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
      + '(?:\\s*\\([^()]*\\))?(?=\\s*(?:,|\\r?\\n|$))', 'i'))
  const references = []
  while (text) {
    const match = patterns.map((pattern) => text.match(pattern)).find(Boolean)
    const reference = match ? match[0] : text.split(/,|\r?\n/)[0]
    references.push(reference.trim())
    text = text.slice(reference.length).replace(/^\s*[,\r\n]\s*/, '').trim()
  }
  return unique(references)
}

export function productIdsFromCell(value, products) {
  return unique(productReferences(value, products).map((reference) => resolveProductReference(reference, products)))
}

export function unresolvedProductReferences(references, products) {
  const ids = new Set(products.map((product) => key(product.prodId)))
  return productIdsFromCell(references, products).filter((reference) => !ids.has(key(reference)))
}
