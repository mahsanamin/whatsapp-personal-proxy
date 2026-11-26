/**
 * The last check on a model-written auto-reply before it can be sent. The
 * system prompt asks the model not to talk about other people; this does not
 * rely on it. A reply that carries a number, an address, a link, another
 * contact's saved name or a copy of the owner's instructions is discarded.
 *
 * Pure: the caller passes the saved-name tokens, so this stays testable
 * without the database.
 */

const ECHO_WORDS = 8
const MIN_NAME_LETTERS = 4

const WA_ADDRESS = /@(?:s\.whatsapp\.net|lid|g\.us|c\.us|broadcast|newsletter)\b|\bs\.whatsapp\.net\b/i
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u
const URL_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/\S/i
const URL_WWW = /\bwww\.[a-z0-9-]/i
const URL_SHORT = /\b(?:wa\.me|t\.me|bit\.ly|goo\.gl|tinyurl\.com)\b/i
const URL_DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|me|co|pk|ae|sa|sg|in|uk|us|app|dev|ly|gl|gg|info|biz|xyz|link|site|online|store|shop)\b(?![\p{L}\p{N}])/iu
// Digits joined by the separators people put in phone numbers, at most two
// between digits, so "14.00 - 15.30" stays two short runs. Any script's digits.
const DIGIT_RUN = /\+?\(?\p{Nd}(?:[\s().-]{0,2}\p{Nd})*/gu
const DATE = /^(?:\p{Nd}{4}[-.]\p{Nd}{1,2}[-.]\p{Nd}{1,2}|\p{Nd}{1,2}[-.]\p{Nd}{1,2}[-.]\p{Nd}{4})$/u

// Words that are also saved as names often enough to block ordinary replies.
const STOPWORDS = new Set([
  // English
  'about', 'after', 'again', 'also', 'away', 'baby', 'back', 'bank', 'been', 'before', 'best', 'busy',
  'call', 'calls', 'care', 'cash', 'chat', 'come', 'dear', 'doctor', 'done', 'down', 'driver', 'family',
  'fine', 'free', 'friend', 'from', 'good', 'great', 'group', 'have', 'hello', 'here', 'home', 'honey',
  'hope', 'hour', 'hours', 'just', 'know', 'later', 'like', 'love', 'meeting', 'message', 'mobile',
  'more', 'morning', 'much', 'night', 'office', 'okay', 'once', 'only', 'phone', 'please', 'reply',
  'right', 'room', 'shop', 'sleep', 'sleeping', 'some', 'soon', 'sorry', 'still', 'store', 'sweet',
  'take', 'team', 'than', 'thank', 'thanks', 'that', 'them', 'then', 'there', 'they', 'this', 'time',
  'today', 'tomorrow', 'until', 'very', 'wait', 'were', 'what', 'when', 'will', 'with', 'work',
  'working', 'would', 'your', 'yours', 'brother', 'sister', 'mother', 'father', 'uncle', 'aunt',
  'aunty', 'auntie', 'wife', 'husband', 'cousin', 'boss', 'admin', 'support', 'service', 'sales',
  // Roman Urdu and common honorifics
  'abbu', 'ammi', 'ammu', 'abba', 'amma', 'bhai', 'bhaiya', 'baji', 'appi', 'apie', 'behn', 'bhabhi',
  'chacha', 'chachi', 'mamu', 'mama', 'mami', 'khala', 'khalu', 'phuppo', 'nana', 'nani', 'dada', 'dadi',
  'beta', 'jaan', 'janu', 'sahab', 'sahib', 'saab', 'sir', 'madam', 'miss', 'abhi', 'baad', 'baat',
  'bata', 'batao', 'dekh', 'dekho', 'haan', 'jaldi', 'kaam', 'kahan', 'kaise', 'kyun', 'kuch', 'main',
  'mein', 'nahi', 'nahin', 'phir', 'thora', 'thoda', 'theek', 'wapas', 'aaj', 'kal', 'raat', 'subah',
  'shukriya', 'inshallah', 'mashallah', 'salam', 'salaam', 'assalam', 'alaikum', 'walaikum',
  // Words businesses put in their saved names, and what a reply talks about
  'whatsapp', 'auto', 'autoreply', 'number', 'numbers', 'contact', 'contacts', 'someone', 'person',
  'people', 'everyone', 'nobody', 'anyone', 'other', 'others', 'price', 'prices', 'rate', 'rates',
  'deal', 'deals', 'sale', 'offer', 'order', 'delivery', 'courier', 'payment', 'account', 'card',
  'block', 'road', 'street', 'city', 'town', 'colony', 'market', 'plaza', 'mall', 'center', 'centre',
  'house', 'housing', 'society', 'property', 'estate', 'construction', 'builders', 'traders',
  'trading', 'enterprises', 'company', 'group', 'global', 'international', 'management', 'school',
  'college', 'university', 'hospital', 'clinic', 'pharmacy', 'lab', 'hotel', 'restaurant', 'cafe',
  'bakery', 'mart', 'motors', 'motor', 'cars', 'bike', 'bikes', 'drive', 'driver', 'rent', 'taxi',
  'battery', 'charger', 'solar', 'electric', 'hybrid', 'tyres', 'tires', 'parts', 'repair', 'paint',
  'frame', 'lock', 'lights', 'water', 'green', 'smart', 'fast', 'plus', 'master', 'model', 'life',
  'exchange', 'travel', 'travels', 'tours', 'agency', 'insurance', 'tailor', 'salon', 'gym', 'fitness',
  'mobile', 'mobiles', 'computer', 'computers', 'electronics', 'internet', 'cable', 'news', 'online',
  'class', 'tuition', 'teacher', 'student', 'manager', 'owner', 'agent', 'dealer', 'guard', 'maid',
  'cook', 'plumber', 'electrician', 'carpenter', 'mechanic', 'gardener', 'cleaner', 'landlord',
  'neighbour', 'neighbor', 'colleague', 'partner', 'client', 'customer', 'chinese', 'english',
  'lahore', 'karachi', 'islamabad', 'rawalpindi', 'peshawar', 'multan', 'faisalabad', 'quetta',
  'punjab', 'sindh', 'pakistan', 'dubai', 'sharjah', 'abudhabi', 'riyadh', 'jeddah', 'doha',
  'singapore', 'london', 'india', 'china', 'toyota', 'honda', 'suzuki', 'chery', 'cherry', 'kia',
  'hyundai', 'changan', 'apple', 'samsung', 'google',
])

const words = (text) => (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])

/**
 * The tokens of saved names that would identify a contact: whole words of at
 * least four letters, lowercased, minus common words.
 */
export function nameTokens(names) {
  const out = new Set()
  for (const name of names) {
    for (const token of String(name || '').toLowerCase().match(/\p{L}+/gu) || []) {
      if ([...token].length >= MIN_NAME_LETTERS && !STOPWORDS.has(token)) out.add(token)
    }
  }
  return out
}

function hasPhoneNumber(text) {
  for (const [run] of text.matchAll(DIGIT_RUN)) {
    const digits = run.replace(/\P{Nd}/gu, '')
    if (digits.length >= 7 && !DATE.test(run.trim())) return true
  }
  return false
}

function hasUrl(text) {
  return URL_SCHEME.test(text) || URL_WWW.test(text) || URL_SHORT.test(text) || URL_DOMAIN.test(text)
}

function echoesInstructions(text, instructions) {
  const source = words(instructions)
  if (source.length < ECHO_WORDS) return false
  const runs = new Set()
  for (let i = 0; i + ECHO_WORDS <= source.length; i++) runs.add(source.slice(i, i + ECHO_WORDS).join(' '))
  const reply = words(text)
  for (let i = 0; i + ECHO_WORDS <= reply.length; i++) {
    if (runs.has(reply.slice(i, i + ECHO_WORDS).join(' '))) return true
  }
  return false
}

function namesAnotherContact(text, { contactNames, allowedNames, instructions }) {
  if (!contactNames?.size) return false
  const allowed = nameTokens([...(allowedNames || []), instructions])
  for (const token of String(text).toLowerCase().match(/\p{L}+/gu) || []) {
    if (contactNames.has(token) && !allowed.has(token)) return true
  }
  return false
}

/**
 * Why a model reply may not be sent, or null when it may.
 *
 * `contactNames` is the nameTokens() set of every saved contact.
 * `allowedNames` are names this reply may use: the current chat's own saved
 * names, the sender name the model was given, and the owner's. Words of the
 * rule's own `instructions` are allowed too, since the owner wrote them.
 *
 * Kinds: wa_address, email, url, phone, contact_name, instructions.
 */
export function guardReply(text, { contactNames, allowedNames = [], instructions = '' } = {}) {
  if (typeof text !== 'string') return null
  if (WA_ADDRESS.test(text)) return 'wa_address'
  if (EMAIL.test(text)) return 'email'
  if (hasUrl(text)) return 'url'
  if (hasPhoneNumber(text)) return 'phone'
  if (namesAnotherContact(text, { contactNames, allowedNames, instructions })) return 'contact_name'
  if (echoesInstructions(text, instructions)) return 'instructions'
  return null
}
