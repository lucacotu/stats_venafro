# Basket Venafro — Statistiche (sito pubblico)

Pagina web pubblica con le statistiche di **Basket Venafro** (Under 17 e Under 19 Gold Campania),
aggiornata **automaticamente** da GitHub, anche a computer spento. I visitatori non devono fare
login; si passa da una squadra all'altra con un selettore.

Come funziona: un'azione programmata su GitHub fa **login → scarica i dati → logout** e salva
`data.json`; **GitHub Pages** pubblica `index.html`, che legge quel file a ogni apertura.

---

## Messa in funzione (una volta sola)

### 1) Crea il repository
- Su GitHub crea un **nuovo repository pubblico** (es. `basket-venafro-stats`).
- Carica dentro **tutti i file di questa cartella** (inclusa la cartella `.github`).
  Da terminale, dentro la cartella:
  ```bash
  git init
  git add .
  git commit -m "Sito statistiche Basket Venafro"
  git branch -M main
  git remote add origin https://github.com/<tuo-utente>/basket-venafro-stats.git
  git push -u origin main
  ```

### 2) Inserisci le credenziali (restano segrete)
Nel repository: **Settings → Secrets and variables → Actions → New repository secret**. Crea due segreti:
- `FIP_EMAIL` → l'email del tuo account FIP
- `FIP_PASSWORD` → la password del tuo account FIP

> I Secrets sono **cifrati**: non compaiono nella pagina, nel codice, né nei log. Io non li vedo mai.

### 3) Attiva GitHub Pages
**Settings → Pages → Build and deployment → Source: Deploy from a branch →** Branch **`main`**, cartella **`/ (root)`** → **Save**.
Dopo qualche minuto il sito sarà a:
```
https://<tuo-utente>.github.io/basket-venafro-stats/
```

### 4) Primo aggiornamento
**Actions → "Aggiorna statistiche" → Run workflow.** Al termine `data.json` viene riempito con i
dati reali e la pagina mostra le statistiche. Da lì in poi si aggiorna **da sola due volte al giorno**
(circa mattina e sera, ora italiana), e puoi sempre forzare un aggiornamento con **Run workflow**.

---

## Se il primo aggiornamento dà errore sulle squadre
Lo script cerca le squadre per nome. Se non le trova, nei log dell'azione (**Actions → ultimo run →
step "Scarica le statistiche"**) viene stampato l'elenco di ciò che ha trovato. Basta correggere in
`fetch-stats.js` il campo `competitionName` (o `searchName`) di ciascuna squadra per farlo combaciare,
poi ripubblicare.

## Cambiare squadre o statistiche
- **Squadre:** modifica l'array `TEAMS` in `fetch-stats.js` (nome squadra + nome campionato).
- **Unione duplicati:** `mergeDuplicates: true` unisce i giocatori con lo stesso nome (attivo per l'U17).
- **Colonne mostrate / ordine:** si regolano in `index.html` (array `COLS`).

## File del progetto
```
├─ fetch-stats.js              # login → scarica → logout → scrive data.json
├─ index.html                  # pagina pubblica interattiva (switch squadre, tabella ordinabile)
├─ data.json                   # dati generati (aggiornati dall'azione; parte con dati di esempio)
├─ .github/workflows/update.yml# azione programmata (2 volte al giorno) + avvio manuale
├─ package.json
└─ .gitignore
```

## Note
- Il repository è **pubblico** (necessario per Pages e Actions gratis illimitate): il codice è visibile,
  ma **non** le credenziali (stanno nei Secrets). I dati statistici sono anch'essi pubblici, come da richiesta.
- Usando il tuo account Gold, a ogni aggiornamento la "sessione attiva" passa per un attimo al server:
  può sloggare brevemente il telefono/app, che poi riprende la sessione da solo. Succede ~2 volte al giorno.
- Progetto non ufficiale, a uso personale. Usa solo il tuo account.
