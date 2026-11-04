<?php
/**
 * Contact form of bitcrane.de.
 *
 * Receives the form from the start page and sends it as a plain-text e-mail to the
 * RaccoonWorks mailbox. Nothing is written to disk: no database, no log of messages,
 * no stored IP addresses. Spam is held off without third-party services (no captcha):
 *  - a hidden "website" field that people leave empty but bots fill in,
 *  - a minimum time between loading the page and sending (bots post at once),
 *  - requests from other sites are refused (Origin check).
 * Spam caught this way gets the same "sent" answer as a real message, so bots learn nothing.
 *
 * The page sends with "Accept: application/json" and gets {ok, code}; without JavaScript the
 * browser posts normally and gets a short page in German and English.
 */

declare(strict_types=1);

date_default_timezone_set('Europe/Berlin');

// Mailbox that receives the messages, and the sender address (an existing mailbox on the same
// hosting account, so the mail server accepts it). The real addresses live in kontakt.config.php
// next to this file, which is not part of the public repository; without it the public address
// is used for both.
$config = is_file(__DIR__ . '/kontakt.config.php') ? (array)require __DIR__ . '/kontakt.config.php' : [];
define('MAIL_TO', (string)($config['to'] ?? 'info@bitcrane.de'));
define('MAIL_FROM', (string)($config['from'] ?? 'info@bitcrane.de'));
const MIN_SECONDS = 3;
const MAX_MESSAGE = 5000;

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

$wantsJson = str_contains($_SERVER['HTTP_ACCEPT'] ?? '', 'application/json');
$lang = (($_POST['lang'] ?? '') === 'en') ? 'en' : 'de';

/** Ends the request with the outcome, as JSON or as a small page. */
function finish(bool $ok, string $code, bool $json, string $lang): never
{
    if ($json) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => $ok, 'code' => $code]);
        exit;
    }
    $texts = [
        'de' => [
            'sent' => 'Danke! Deine Nachricht ist angekommen. Wir antworten per E-Mail.',
            'email' => 'Bitte prüfe deine E-Mail-Adresse und versuche es noch einmal.',
            'short' => 'Bitte schreib ein paar Worte mehr und versuche es noch einmal.',
            'error' => 'Das hat leider nicht geklappt. Schreib uns bitte direkt an info@bitcrane.de.',
            'back' => 'Zurück zur Startseite',
        ],
        'en' => [
            'sent' => 'Thank you! Your message has arrived. We will reply by email.',
            'email' => 'Please check your email address and try again.',
            'short' => 'Please write a few more words and try again.',
            'error' => 'Sorry, that did not work. Please write to info@bitcrane.de directly.',
            'back' => 'Back to the start page',
        ],
    ];
    $t = $texts[$lang];
    $line = $t[$code] ?? $t['error'];
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html lang="' . $lang . '"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
        . '<title>Bitcrane</title><link rel="stylesheet" href="legal.css"></head><body><main class="wrap">'
        . '<h1>Bitcrane</h1><p>' . htmlspecialchars($line, ENT_QUOTES, 'UTF-8') . '</p>'
        . '<p><a href="index.html#kontakt">' . htmlspecialchars($t['back'], ENT_QUOTES, 'UTF-8') . '</a></p>'
        . '</main></body></html>';
    exit;
}

/** One line without line breaks or control characters (keeps headers safe). */
function oneLine(string $value, int $max): string
{
    $value = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value) ?? '';
    return mb_substr(trim($value), 0, $max);
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    http_response_code(405);
    finish(false, 'error', $wantsJson, $lang);
}

// Only forms of this site: a browser sends the Origin header with every POST.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$originHost = (string)parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : '');
if ($origin !== '' && strcasecmp($originHost, (string)($_SERVER['HTTP_HOST'] ?? '')) !== 0) {
    http_response_code(403);
    finish(false, 'error', $wantsJson, $lang);
}

// Spam traps: pretend success.
if (trim((string)($_POST['website'] ?? '')) !== '') {
    finish(true, 'sent', $wantsJson, $lang);
}
$ts = (int)($_POST['ts'] ?? 0);
if ($ts > 0 && time() - $ts < MIN_SECONDS) {
    finish(true, 'sent', $wantsJson, $lang);
}

$name = oneLine((string)($_POST['name'] ?? ''), 100);
$email = oneLine((string)($_POST['email'] ?? ''), 200);
$message = trim(str_replace("\r\n", "\n", (string)($_POST['message'] ?? '')));

if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
    finish(false, 'email', $wantsJson, $lang);
}
if (mb_strlen($message) < 10) {
    finish(false, 'short', $wantsJson, $lang);
}
$message = mb_substr($message, 0, MAX_MESSAGE);

// Kind of message (chosen on the form) and, for bug reports, where it happened.
$categories = ['question' => 'Frage', 'bug' => 'Fehler', 'idea' => 'Idee', 'other' => 'Sonstiges'];
$category = $categories[(string)($_POST['category'] ?? '')] ?? 'Sonstiges';
$version = oneLine((string)($_POST['version'] ?? ''), 40);
$os = in_array($_POST['os'] ?? '', ['macOS', 'Windows'], true) ? (string)$_POST['os'] : '';

$subject = '[Bitcrane] ' . $category . ($name !== '' ? ' – ' . $name : '');
$body = "Nachricht über das Kontaktformular auf bitcrane.de. Mit „Antworten“ geht die Antwort an den Absender.\n\n"
    . "Art: " . $category . "\n"
    . "Name: " . ($name !== '' ? $name : '-') . "\n"
    . "E-Mail: " . $email . "\n"
    . ($category === 'Fehler' ? "Bitcrane-Version: " . ($version !== '' ? $version : '-') . "\nSystem: " . ($os !== '' ? $os : '-') . "\n" : '')
    . "Sprache der Seite: " . $lang . "\n"
    . "Gesendet: " . date('d.m.Y H:i') . "\n\n"
    . $message . "\n";

$headers = [
    'From' => 'Bitcrane Webseite <' . MAIL_FROM . '>',
    'Reply-To' => $email,
    'MIME-Version' => '1.0',
    'Content-Type' => 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding' => '8bit',
    'X-Mailer' => 'bitcrane.de contact form',
];

$sent = mail(MAIL_TO, mb_encode_mimeheader($subject, 'UTF-8'), $body, $headers, '-f' . MAIL_FROM);
finish($sent, $sent ? 'sent' : 'error', $wantsJson, $lang);
