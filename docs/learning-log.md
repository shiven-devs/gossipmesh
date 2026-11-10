# Learning log

Har phase ke end mein 5 line: kya seekha, kya confusing tha, kaise solve hua.

## Phase 0

package.json mein "type": "module" hata do to test/smoke.test.js mein exactly kaunsi line pehle phategi, aur error kya aayega?
test/smoke.test.js ke teeno tests ek hi KNOWN_FRIENDS Map share karte hain (legacy/state.js:4 module-level hai). Agar main teeno ka order ulat doon, kaunsa test fail hoga aur kyun? Phase 1 mein MemberList ko class banane se ye problem kaise khatam ho jaati hai?
.gitignore mein CLAUDE.md daalne se wo GitHub pe nahi jaayega — par agar aapne galti se usse pehle hi commit kar diya hota, to .gitignore add karne se wo file history se hat jaati? Nahi, to hataane ka asli tareeka kya hai, aur wo bhi kis cheez ko fix nahi karta?

## Phase 1
