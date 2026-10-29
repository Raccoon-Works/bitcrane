# Bitcrane on the command line

[Deutsch](#deutsch) · [English](#english)

---

## Deutsch

Bitcrane lässt sich aus Skripten aufrufen und überträgt dann ohne Fenster, mit den
Servern, die in Bitcrane gespeichert sind. Passwörter kommen aus dem Schlüsselbund
bzw. der Windows-Anmeldeinformationsverwaltung. Verbinde dich deshalb einmal in der
App mit dem Server, bestätige den Hostschlüssel und speichere das Passwort.

### Befehle

```text
bitcrane servers                                  gespeicherte Server
bitcrane ls <server>[:<pfad>]                     Ordner auf dem Server auflisten
bitcrane upload <lokal>... --to <server>[:<ordner>]   Dateien und Ordner hochladen
bitcrane download <server>:<pfad>... [--to <ordner>]  herunterladen (Standard: aktueller Ordner)
bitcrane help
```

`<server>` ist der Name des Servers in Bitcrane (Groß-/Kleinschreibung egal). Ohne
Pfad gilt der Startordner des Servers. `--quiet` zeigt nur Fehler.

Rückgabewert: `0` alles übertragen, `1` Verbindung oder eine Datei fehlgeschlagen,
`2` falsch aufgerufen.

### Wo liegt das Programm?

Den genauen Pfad zeigt Bitcrane unter **Einstellungen › Allgemein › Kommandozeile**.

- **macOS:** `/Applications/Bitcrane.app/Contents/MacOS/bitcrane`. Bequemer mit einem
  Alias in `~/.zshrc`:
  `alias bitcrane="/Applications/Bitcrane.app/Contents/MacOS/bitcrane"`
- **Windows:** meist `%LOCALAPPDATA%\Bitcrane\bitcrane.exe`. Bitcrane ist ein
  Fensterprogramm, deshalb wartet die Eingabeaufforderung nicht von selbst auf das
  Ende. So wartet sie:
  - Eingabeaufforderung: `start /wait "" "%LOCALAPPDATA%\Bitcrane\bitcrane.exe" upload bericht.pdf --to Webserver:/var/www`
  - PowerShell: `& "$env:LOCALAPPDATA\Bitcrane\bitcrane.exe" upload bericht.pdf --to Webserver:/var/www | Out-Default`

### Beispiele

```text
bitcrane upload dist --to Webserver:/var/www/html
bitcrane download "NAS:/daten/Fotos 2026" --to ~/Bilder
bitcrane ls Dropbox:/Projekte
```

---

## English

Bitcrane can be called from scripts and then transfers without a window, using the
servers saved in Bitcrane. Passwords come from the macOS Keychain or the Windows
Credential Manager, so connect to the server once in the app, confirm the host key and
save the password.

### Commands

```text
bitcrane servers                                  saved servers
bitcrane ls <server>[:<path>]                     list a server folder
bitcrane upload <local>... --to <server>[:<folder>]   upload files and folders
bitcrane download <server>:<path>... [--to <folder>]  download (default: current folder)
bitcrane help
```

`<server>` is the name of the server in Bitcrane (case-insensitive). Without a path,
the server's start folder is used. `--quiet` only prints errors.

Exit code: `0` everything transferred, `1` the connection or a file failed, `2` wrong usage.

### Where is the program?

Bitcrane shows the exact path under **Settings › General › Command line**.

- **macOS:** `/Applications/Bitcrane.app/Contents/MacOS/bitcrane`. An alias in
  `~/.zshrc` makes it shorter:
  `alias bitcrane="/Applications/Bitcrane.app/Contents/MacOS/bitcrane"`
- **Windows:** usually `%LOCALAPPDATA%\Bitcrane\bitcrane.exe`. Bitcrane is a windowed
  program, so the command prompt does not wait for it by itself. To wait:
  - Command prompt: `start /wait "" "%LOCALAPPDATA%\Bitcrane\bitcrane.exe" upload report.pdf --to Webserver:/var/www`
  - PowerShell: `& "$env:LOCALAPPDATA\Bitcrane\bitcrane.exe" upload report.pdf --to Webserver:/var/www | Out-Default`

### Examples

```text
bitcrane upload dist --to Webserver:/var/www/html
bitcrane download "NAS:/data/Photos 2026" --to ~/Pictures
bitcrane ls Dropbox:/Projects
```
