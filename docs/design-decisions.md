# Design decisions

Har "kyun" ka jawab yahan likho (interview prep). Phase ke saath badhta jaayega.
Sabse zaroori 3 badlaav

1. Global Map ki jagah class
Pehle list ek hi jagah thi, sab ke liye. Ab new MemberList() se har baar nayi list banti hai. Isse tests ek-doosre ko nahi bigaadte (tumhara wo “order ulta” wala sawaal).

2. Ab poori list dono taraf jaati hai
Pehle tum dost ko sirf apna address bhejte the. Ab tum apni poori list bhejte ho, aur wo apni poori list wapas bhejta hai. Isse khabar jaldi phailti hai.

3. Galat data se bachav
Dusre node se jo data aata hai wo ulta-seedha ho sakta hai. Ab code pehle check karta hai, phir hi list mein daalta hai.

Baaki sab kya hai?

Baaki (Object.freeze, allSettled, pathToFileURL jaise) chhoti-chhoti details hain. Ye abhi yaad karne ki zaroorat nahi. Jab tum us file ko khol ke dekhoge, tab ek-ek karke samajh aayengi.

Faisla 1: naya setting REQUEST_TIMEOUT_MS

Kya hua: Purane code mein “dost ka jawab kitni der tak wait karna hai” ek number (2000 ms) seedha code ke andar likha tha. Plan ka rule hai ki koi bhi number code mein seedha nahi likhna, sab settings se aayenge. To usne isko ek setting bana diya.

Misaal: Jaise restaurant mein “10 minute mein khana nahi aaya to chhod do” rule manager ki list mein likha ho, waiter ke dimaag mein nahi.

Saath mein ek rule: timeout round ke gap se chhota hona chahiye. Agar round 1 second ka hai aur timeout 5 second ka, to ek round khatam hone se pehle doosra shuru ho jaayega. Isliye config yahi check karta hai.

Mera vote: rakho.

Faisla 2: node khud apni list mein hai

Kya hua: Pehle node khud ko list mein nahi rakhta tha, sirf dusron ko. Ab wo list mein sabse pehle khud hota hai.

Kyun: Phase 2 mein node apna “main zinda hoon” wala counter (heartbeat) badhayega, aur wo counter kahin store hona chahiye. Agar abhi self ko list mein na daalte, to Phase 2 mein teen functions dobara likhne padte.

Misaal: Class ki attendance register mein teacher apna naam bhi pehle se likhke rakhe, baad mein jodne se achha.

Mera vote: rakho.

Faisla 3: seeds ab “members” nahi hain

Kya hua: Pehle localhost:3001 jaise seeds seedha dost-list mein daal diye jaate the. Ab seeds sirf “jaake baat karne ke pehle address” ki alag list hain. Node tabhi member banta hai jab wo jawab de.

Misaal: Kisi ne tumhe ek phone number diya. Wo number tumhara dost nahi hai. Dost tab banta hai jab wo phone uthaye aur apna naam bataye.

Dhyan rakho: ye purane code se dikhne wala badlaav hai. Pehle /friends mein seeds turant dikhte the, ab jawab milne ke baad dikhenge.

Mera vote: rakho.

Jo jaanbujhkar nahi kiya: SIGTERM

Kya hai: SIGTERM wo signal hai jo Kubernetes pod band karne se pehle bhejta hai, taaki node “main ja raha hoon” bolke band ho. Ye Phase 3 mein aayega, abhi nahi.

Windows wali baat: Windows (seedha PowerShell mein) asli SIGTERM signal nahi deta, to us par ye test hi nahi ho sakta. Isliye Phase 3 mein WSL (Ubuntu) zaroori hai. Tumne to pehle se plan mein WSL mein hi sab chalane ka likha tha, to dikkat nahi.

Mera vote: theek hai, abhi chhodna sahi hai.


# phase3



PLAN se jaan ke hat ke liye (2 cheezein)
localStatus mein left bhi hai — PLAN kehta hai alive/suspect/dead. Chaar value rakhne se dashboard ko ek hi field pe colour karna padta hai, aur timers ke liye "ye member exempt hai" ek jagah likha jaata hai. Agar aap PLAN ke exact 3 value chahte ho, to dashboard ko status === "left" alag se check karna padega — bolo to badal doon.
SHUTDOWN_TIMEOUT_MS naya env var hai (PLAN ke table mein nahi). Iske bina graceful leave Kubernetes ke grace period se lamba kheench sakta tha.
3 sawaal
markSelfLeft() heartbeat +1 karta hai. Agar main wo bump hata doon aur sirf status = "left" set karoon, to peers ke paas kya pahunchega aur wo left kabhi dekhenge? (Hint: merge() ka pehla guard socho.)
sweep() self ko skip karta hai. Maan lo main wo continue hata doon aur kisi node ka gossip loop 20 second ke liye ruk jaaye (event loop block). Us node ke apne /members mein kya dikhega, aur kya wo galat raay doosre nodes tak pahunchegi? Kyun ya kyun nahi?
Graveyard gravestone ko CLEANUP_MS baad bhool jaata hai. Ek aisi sequence banao jisme wo bhoolna actually ek zombie paida kar de — kitni der ke liye kisi peer ko partition mein rehna padega, aur kya us peer ke paas us member ki entry bachegi bhi? Isse CLEANUP_MS kitna hona chahiye, iske baare mein kya conclusion nikalta hai?

3 sawaal
RumorStore mein #seen Set hata do aur sirf #rumors Map rakho (jo rumor evict ho gaya wo bhool jao). Ek concrete sequence batao jisse ek rumor hamesha cluster mein ghoomta rahe. MAX_RUMORS is problem ko kaise trigger karta hai?
/health cluster ko ignore karta hai, /ready nahi. Maan lo maine galti se /health ko bhi "kam se kam ek peer alive dikhe" bana diya, aur Kubernetes pe 10 pods ka total partition ho gaya (5-5). Step by step batao kya hoga — aur /ready ke saath wahi galti karne pe kya hota (woh kam bura kyun hai)?
Verification mein rumor 173ms mein phail gaya, jabki ek round 400ms ka hai. Mechanism exactly kya hai? Aur ab socho: agar main push-pull ki jagah sirf push rakhoon (reply mein rumors na bhejun), to 5 nodes pe spread time kitna badlega, aur hops ke numbers kaise dikhenge?

Dockerfile mein COPY src ./src ko COPY package*.json ./ se upar le jao. Image bilkul same banegi. Phir bhi ye change kyun bura hai — src/server.js mein ek comment badalne pe build mein exactly kya dobara hoga?
HEALTHCHECK /health hit karta hai, /ready nahi. Maan lo maine /ready kar diya, aur docker compose up pe saare 5 nodes ek saath start hote hain. Pehle 10 second mein kya hoga? (Hint: /ready 503 deta hai jab tak ek exchange na ho.) Aur Phase 7 mein Kubernetes ke liye ye galti isse bhi zyada khatarnak kyun hai?
docker compose kill -s SIGKILL node4 ke baad node4 down pada rehta hai, par /chaos/crash ke baad Docker use wapas le aata hai. Dono case mein peers ka view kaise alag hoga (status, localStatus, generation) — aur agar Kubernetes mein kubectl delete pod karein, to wo in dono mein se kis case jaisa hai?



3 sawaal
Matrix mein node2 ka row node4 ko dead dikhata hai, par node4 ka apna row khud ko alive dikhata hai aur reachable hai. Teen possible wajah batao, aur dashboard ke paas jo data hai usse aap in teen mein se kaise distinguish karoge (kaunsa field dekhoge)?
Dashboard ne spread 0 ms report kiya tha. Maan lo main POLL_INTERVAL_MS ko 50ms kar doon taaki precision badhe. Teen cheezein batao jo kharab hongi — aur ek aisa tareeka socho jisse spread sahi naapa ja sake bina poll interval ghataye. (Hint: kaun jaanta hai ki rumor usay exactly kab mila, aur wo kis clock pe hai?)
ClusterView.update() unreachable node ka purana view rakhta hai (stale: true). Maan lo main usko blank kar doon (row khaali). Partition demo ke dauraan page pe kya galat impression banega — aur summary.disagreements ka number kaise jhooth bolne lagega?


3 sawaal
publishNotReadyAddresses: true hata do. Pods ban jaayenge, par logs mein exactly kya dikhega aur cluster kis state mein phans jaayega? Trace karo: pod boot → /ready → Service DNS → SEED_DNS resolve. Deadlock kahan banta hai?
Revival probe fanout ke upar ek extra target add karta hai, uske andar nahi. Agar main usko fanout ke andar hi rakhoon (ek live peer ka slot le lein), to 20-node cluster mein jahan 15 nodes dead hain — convergence pe kya asar padega? Aur agar revive ko 5 kar doon?
kubectl delete pod graceful nikla, aur --force --grace-period=0 bhi left dikha kyunki hamara farewell ~15ms ka hai. Ek aisa change batao (code ya manifest mein) jisse --force wala case sach mein crash jaisa dikhe — aur phir socho: ye change production ke liye accha hoga ya bura?