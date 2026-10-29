# Google Drive in Bitcrane

[Deutsch](#deutsch) · [English](#english)

Google lets programs like Bitcrane use Google Drive for free only with an app key of
your own. Setting it up takes about ten minutes, costs nothing and needs no credit card.
You do it once; afterwards Bitcrane signs in by itself.

---

## Deutsch

### Was du brauchst

- Ein Google-Konto (das, dessen Drive du nutzen willst)
- Bitcrane 0.2.36 oder neuer

### 1. Projekt anlegen

1. Öffne die [Google Cloud Console](https://console.cloud.google.com/) und melde dich an.
   Beim ersten Besuch fragt Google nach Land und Nutzungsbedingungen.
2. Oben links neben „Google Cloud“ auf die Projektauswahl klicken, dann **Neues Projekt**.
3. Name zum Beispiel `Bitcrane`, **Erstellen**. Warte, bis das Projekt fertig ist, und wähle es oben aus.

Ein Rechnungskonto (Billing) brauchst du nicht.

### 2. Google Drive API einschalten

1. Im Menü **APIs & Dienste › Bibliothek** öffnen.
2. Nach **Google Drive API** suchen, anklicken, **Aktivieren**.

### 3. Anmeldeseite einrichten

1. Im Menü **Google Auth Platform** öffnen (früher „OAuth-Zustimmungsbildschirm“) und **Jetzt starten** klicken.
2. **App-Informationen:** App-Name zum Beispiel `Bitcrane (privat)`, als Support-E-Mail deine eigene Adresse.
3. **Zielgruppe:** **Extern**.
4. **Kontaktdaten:** wieder deine Adresse. Den Richtlinien zustimmen, **Erstellen**.

### 4. App „in Produktion“ stellen (wichtig)

1. In der Google Auth Platform links **Zielgruppe** öffnen.
2. Unter „Veröffentlichungsstatus“ auf **App veröffentlichen** klicken und bestätigen.
   Der Status lautet danach **In Produktion**.

Warum: Im Status **Testen** läuft deine Anmeldung nach **7 Tagen** ab. Bitcrane müsste sich dann jede Woche neu anmelden.
Eine Prüfung durch Google brauchst du für deine eigene App nicht. Google zeigt beim Anmelden nur einmal einen Hinweis (siehe Schritt 7).

### 5. Schlüssel (Client) anlegen

1. Links **Clients** öffnen, dann **Client erstellen**.
2. **Anwendungstyp: Desktop-App**, Name zum Beispiel `Bitcrane`, **Erstellen**.
3. Google zeigt jetzt **Client-ID** und **Clientschlüssel** (beginnt meist mit `GOCSPX-`).
   Beides kopieren. Den Schlüssel kannst du später unter **Clients** wieder abrufen oder neu erzeugen.

### 6. In Bitcrane eintragen

1. In Bitcrane **Server hinzufügen** (oder unter **Cloud-Dienste** doppelt auf **Google Drive** klicken).
2. **Protokoll: Cloud-Dienst**, **Dienst: Google Drive**.
3. **Client-ID** und **Client-Schlüssel** einfügen, dann **Bei Google Drive anmelden …**.

Die Client-ID merkt sich Bitcrane in seinen Einstellungen, den Schlüssel im Schlüsselbund (Mac) bzw. in der
Windows-Anmeldeinformationsverwaltung. Für weitere Google-Konten nutzt Bitcrane denselben Schlüssel.

### 7. Im Browser anmelden

1. Der Browser öffnet die Google-Anmeldung. Konto wählen.
2. Google zeigt **„Google hat diese App nicht überprüft“**. Das ist bei eigenen Apps normal:
   auf **Erweitert** und dann **Zu Bitcrane (privat) wechseln (unsicher)** klicken. Es ist deine eigene App.
3. Den Zugriff auf Google Drive erlauben und **Weiter** klicken.
4. Der Browser zeigt „Angemeldet“. In Bitcrane öffnet sich dein Google Drive.

### Gut zu wissen

- **Google-Dokumente, Tabellen und Präsentationen** sind keine echten Dateien und lassen sich nicht direkt herunterladen.
  In Google Drive kannst du sie als Word-, Excel- oder PDF-Datei speichern.
- **Löschen** legt Dateien in den Papierkorb von Google Drive (30 Tage wiederherstellbar).
- **„Link zum Teilen kopieren“** kopiert den Drive-Link. Wer ihn öffnen darf, stellst du in Google Drive ein.
- **Zugriff entziehen:** auf [myaccount.google.com/permissions](https://myaccount.google.com/permissions) die App entfernen.
- Fehlermeldung „Google Drive API ist nicht aktiviert“: Schritt 2 nachholen und ein paar Minuten warten.

---

## English

### What you need

- A Google account (the one whose Drive you want to use)
- Bitcrane 0.2.36 or later

### 1. Create a project

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and sign in.
2. Click the project picker next to "Google Cloud", then **New project**.
3. Name it, for example, `Bitcrane`, click **Create** and select it at the top.

No billing account is needed.

### 2. Enable the Google Drive API

**APIs & Services › Library**, search for **Google Drive API**, click **Enable**.

### 3. Set up the sign-in page

1. Open **Google Auth Platform** (formerly "OAuth consent screen") and click **Get started**.
2. App name, for example, `Bitcrane (private)`, with your own address as support e-mail.
3. Audience: **External**. Contact e-mail: your address. Agree and **Create**.

### 4. Publish the app (important)

**Google Auth Platform › Audience › Publish app**, confirm. The status becomes **In production**.

In **Testing** status, your sign-in expires after **7 days** and Bitcrane has to sign in again every week.
Your own app needs no verification by Google; Google only shows a notice once (step 7).

### 5. Create the key (client)

1. **Clients › Create client**.
2. **Application type: Desktop app**, name `Bitcrane`, **Create**.
3. Copy the **Client ID** and the **Client secret** (usually starts with `GOCSPX-`).

### 6. Enter it in Bitcrane

**Add Server › Protocol: Cloud service › Service: Google Drive**, paste both values, click **Sign in to Google Drive …**.
The client ID is kept in Bitcrane's settings, the secret in the macOS Keychain or the Windows Credential Manager.

### 7. Sign in in the browser

1. Choose your account.
2. Google shows **"Google hasn't verified this app"**. That is normal for your own app:
   click **Advanced**, then **Go to Bitcrane (private) (unsafe)**.
3. Allow access to Google Drive and click **Continue**. Your Drive opens in Bitcrane.

### Good to know

- Google Docs, Sheets and Slides are not real files and cannot be downloaded directly; save them as Word, Excel or PDF in Google Drive.
- Deleting moves files to the Google Drive trash (restorable for 30 days).
- "Copy Sharing Link" copies the Drive link; who may open it is set in Google Drive.
- Revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
