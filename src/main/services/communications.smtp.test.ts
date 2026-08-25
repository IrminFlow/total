import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNetworkSmtpTransport,
  type SmtpTransportProfile,
} from "./communications";

// Test-only localhost identity; production always uses the operating system trust store.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDj4+ulLEbYkitf
HkI8oRgdw2xlc5ZjM9J0mek+ajxK2HZdVEp2SBFDgk0P0hypN2CYRwdVVPl1ZWpM
CNmsMe7bXGAiozAYLvgzbF7bRHiWYmO8cDN2gkODMD7SNocYtndDg4gDgZEaUtMV
k9HVil+FzT/uabLcd2t6eyuvHql4me2Th/tulGBC6YHaLcoOVxT95p8PEXFH36Sv
/dyuf6g0XhwuELkh/ViGRdLp8VUlwpc1BatTK5O7emgKl20KW0vWpczeZCqqcDl9
UyWF5Ip3Zbnx1sjxi220O8QWPBJqPuFsPtyl3mZOfL+iQyBA/0gdzxRhyiGraP0p
70BW55pbAgMBAAECggEAE0iCdJAKEKJRtDNBxJKXEVGrduwwcgV9DevGHkdsAaNO
ZLhQsrCHcXBxp+COF019yXTdLH3LvADQXU20aYsyHHK1Gck4NRuoWeWWIzSohYUe
zl+qIyGDp/Kppi0CAnfSIK7dD/rjNdiDTwSakVirm41SFxDvlxMtz4fjmuZbzb4D
xP+Fvi1Tjo92RPExbpnuCudj6oQBTaYGdSrv4UWOxK7CM/jyoNUqcR96MU6NINFa
iks+ilhrlRcHfWL6/Bilt4QlE8TcFL8vMZcGNRDkbG4kDxYisRucH2Thyr3d0j65
iefe1AAPGr8IM4+tK4IAKpTz8ZJ4QMyNczIsyrsqEQKBgQD4uv4BjNlXE7kK+w7B
mwElYli4oZLFTkDZfqMHI+FBNve+CrbyEQIqfcg69pSnBWghFq4hwAjHF23dWf18
RANYZpxVWRv/rfzmYmuOm7YaGGZMzQ9C4B9j5Aqwa4t3vdOFxA3T/AWsBzYg6yDo
p1H5O0QddK665oQUBPQFHzo/CwKBgQDqjQB9amUFui/ZV8V7RM8nooFIXjfjaREo
thR0onEpARGSD7lmmDoQowD14V68yhMTdc8KFwbrgCy8tkH7V7rFzCPAsZ/6WRC+
vu/Q5Fw16cMu82vsH9t3ba2vzyzCF5AXVDN+J9rwTHxtD+ls4zsRgbWShPFmknJG
bfXOwrNj8QKBgF4KBML9R6bedBWsufWE7zf9KOIVZHJolaglcuneLOoFKEGXt3dp
6tG54Jw6YhWLu8TW2Fs2SZtMRmNsBKSY6lLf6Ld0C1vtojJQf63ZPU48b2EWHnEA
X53auBffcUmCYZiveTLulA5oY5SqkTSlHh8Gw0gHt5A+Wy1eegv9tH3lAoGAZmrl
gN4ZeLPBOw15fQch0bPC8h+6FcIGLRm8uuVHtljyHC5jjaoBCMy0maksXhF63O9/
VW+SpPjWEB0hmKfJNZ+bKQQm0AFeL3xeaX+dyCjoArNmN7f9dBvfULqNV79EOvuY
dIjgsDclydW93r8mRtG1wGHuqxRdc+WGBR+9h3ECgYBe2f3/txS94ZH7cjPc9J+S
nIsMSfL8GC0mL6bl1Kn7erPdx8qLacxaBFL+EBiaVIUkvoVJlNTOXJRK1NocaqKT
lOZRy/ej5GBLLlwvRjEqgpxSe46jZb1hty+J4IhnZu46cz5kZawvAi7+H1xu6oD5
TjzTCixMg2tAWql/T8CfeQ==
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUJYTRFPZf/9QFnD/+2dr/KwiWrC4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgyNDE5MDk0N1oXDTM2MDgy
MTE5MDk0N1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA4+PrpSxG2JIrXx5CPKEYHcNsZXOWYzPSdJnpPmo8Sth2
XVRKdkgRQ4JND9IcqTdgmEcHVVT5dWVqTAjZrDHu21xgIqMwGC74M2xe20R4lmJj
vHAzdoJDgzA+0jaHGLZ3Q4OIA4GRGlLTFZPR1Ypfhc0/7mmy3Hdrensrrx6peJnt
k4f7bpRgQumB2i3KDlcU/eafDxFxR9+kr/3crn+oNF4cLhC5If1YhkXS6fFVJcKX
NQWrUyuTu3poCpdtCltL1qXM3mQqqnA5fVMlheSKd2W58dbI8YtttDvEFjwSaj7h
bD7cpd5mTny/okMgQP9IHc8UYcohq2j9Ke9AVueaWwIDAQABo2kwZzAdBgNVHQ4E
FgQURlUBywyu2gjTLtamVaYkvar3pC0wHwYDVR0jBBgwFoAURlUBywyu2gjTLtam
VaYkvar3pC0wDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBAK+glDFaFLlilT6XhOgcd4zrSIfn7P41itUbzArf
Ct8Y7jFXEGeuXJ45k+W2huaOgl2HRE+Be6qEBLkRy4QxoKkYnicfA7XAZcXVVDxB
CFm3NcSgjFRujP9z4X64Z1x0hj1CpKlchlNwidwKe02OyBEebLR9DXIWoHTnVDbH
1awmNzKUW1uX6SeGLGS+WhAdmKU69VlQW1UlmjwFlqpN8CJoHozF0fKVqNx21vQS
zOAP06fIiL1LvBb/bBxZg/i0hUhgqIrIy5Z6awEg3wDWEFNhNO3npZsNkkPv3pYJ
0j/w1u6zPufhA/8aDnS7VT7CrwAHk7I4LWSCX/+9dGfFhdY=
-----END CERTIFICATE-----`;

interface TranscriptEntry {
  line: string;
  secure: boolean;
}

interface ServerBehavior {
  starttls?: boolean;
  rejectRecipient?: boolean;
  silenceAfterGreeting?: boolean;
  oversizedEhlo?: boolean;
  disconnectAfterData?: boolean;
  auth: "plain" | "login";
}

const servers: Array<net.Server | tls.Server> = [];
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function profile(
  port: number,
  security: "tls" | "starttls",
  host = "localhost",
): SmtpTransportProfile {
  return {
    id: 1,
    name: "Loopback",
    host,
    port,
    security,
    username: "books@example.com",
    password: "app-password",
    fromEmail: "books@example.com",
    fromName: "Books",
    replyTo: null,
    active: true,
    hasPassword: true,
    lastTestedAt: null,
    lastError: null,
    createdBy: "Test",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

async function listen(server: net.Server | tls.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as net.AddressInfo).port;
}

function attachProtocol(
  socket: net.Socket | tls.TLSSocket,
  transcript: TranscriptEntry[],
  behavior: ServerBehavior,
  secure: boolean,
): void {
  sockets.add(socket);
  let buffer = "";
  let dataMode = false;
  let loginStep: "username" | "password" | null = null;
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const line = buffer.slice(0, boundary).replace(/\r$/, "");
      buffer = buffer.slice(boundary + 1);
      transcript.push({ line, secure });
      if (dataMode) {
        if (line === ".") {
          dataMode = false;
          if (behavior.disconnectAfterData) socket.destroy();
          else socket.write("250 2.0.0 queued as LOOP-123\r\n");
        }
        continue;
      }
      if (behavior.silenceAfterGreeting) continue;
      if (loginStep === "username") {
        expect(Buffer.from(line, "base64").toString("utf8")).toBe(
          "books@example.com",
        );
        loginStep = "password";
        socket.write("334 UGFzc3dvcmQ6\r\n");
        continue;
      }
      if (loginStep === "password") {
        expect(Buffer.from(line, "base64").toString("utf8")).toBe(
          "app-password",
        );
        loginStep = null;
        socket.write("235 2.7.0 authenticated\r\n");
        continue;
      }
      const verb = line.split(" ", 1)[0]?.toUpperCase();
      if (verb === "EHLO") {
        const capabilities = behavior.oversizedEhlo
          ? `250-${"x".repeat(9_000)}\r\n250 AUTH PLAIN\r\n`
          : behavior.starttls && !secure
            ? "250-localhost\r\n250 STARTTLS\r\n"
            : `250-localhost\r\n250 AUTH ${behavior.auth.toUpperCase()}\r\n`;
        socket.write(capabilities);
      } else if (verb === "STARTTLS" && behavior.starttls && !secure) {
        socket.off("data", onData);
        socket.write("220 2.0.0 ready for TLS\r\n", () => {
          const upgraded = new tls.TLSSocket(socket, {
            isServer: true,
            secureContext: tls.createSecureContext({
              key: TEST_KEY,
              cert: TEST_CERT,
            }),
          });
          attachProtocol(upgraded, transcript, behavior, true);
        });
      } else if (verb === "AUTH" && behavior.auth === "plain") {
        const token = line.split(" ")[2] ?? "";
        expect(Buffer.from(token, "base64").toString("utf8")).toBe(
          "\0books@example.com\0app-password",
        );
        socket.write("235 2.7.0 authenticated\r\n");
      } else if (verb === "AUTH" && behavior.auth === "login") {
        loginStep = "username";
        socket.write("334 VXNlcm5hbWU6\r\n");
      } else if (verb === "NOOP") {
        socket.write("250 2.0.0 ready\r\n");
      } else if (verb === "MAIL") {
        socket.write("250 2.1.0 sender ok\r\n");
      } else if (verb === "RCPT") {
        socket.write(
          behavior.rejectRecipient
            ? "550 5.1.1 recipient rejected\r\n"
            : "250 2.1.5 recipient ok\r\n",
        );
      } else if (verb === "DATA") {
        dataMode = true;
        socket.write("354 end with dot\r\n");
      } else if (verb === "QUIT") {
        socket.write("221 2.0.0 bye\r\n", () => socket.end());
      } else {
        socket.write("500 unsupported command\r\n");
      }
    }
  };
  socket.on("data", onData);
}

async function implicitTlsServer(
  behavior: ServerBehavior,
): Promise<{ port: number; transcript: TranscriptEntry[] }> {
  const transcript: TranscriptEntry[] = [];
  const server = tls.createServer(
    { key: TEST_KEY, cert: TEST_CERT },
    (socket) => {
      attachProtocol(socket, transcript, behavior, true);
      socket.write("220 localhost test SMTP\r\n");
    },
  );
  return { port: await listen(server), transcript };
}

async function starttlsServer(
  behavior: ServerBehavior,
): Promise<{ port: number; transcript: TranscriptEntry[] }> {
  const transcript: TranscriptEntry[] = [];
  const server = net.createServer((socket) => {
    attachProtocol(socket, transcript, behavior, false);
    socket.write("220 localhost test SMTP\r\n");
  });
  return { port: await listen(server), transcript };
}

describe("network SMTP protocol boundary", () => {
  it("submits through implicit TLS with authenticated envelope and DATA", async () => {
    const { port, transcript } = await implicitTlsServer({ auth: "plain" });
    const transport = createNetworkSmtpTransport({ ca: TEST_CERT });
    await expect(
      transport.send(
        profile(port, "tls"),
        "From: <books@example.com>\r\nTo: <customer@example.com>\r\n\r\nHello\r\n",
        ["customer@example.com"],
      ),
    ).resolves.toEqual({
      accepted: true,
      serverResponse: "2.0.0 queued as LOOP-123",
      serverMessageId: "LOOP-123",
    });
    expect(
      transcript.find((entry) => entry.line.startsWith("AUTH"))?.secure,
    ).toBe(true);
    expect(transcript.some((entry) => entry.line === "DATA")).toBe(true);
  });

  it("upgrades with STARTTLS, repeats EHLO, and authenticates only after TLS", async () => {
    const { port, transcript } = await starttlsServer({
      auth: "login",
      starttls: true,
    });
    const transport = createNetworkSmtpTransport({ ca: TEST_CERT });
    await expect(transport.test(profile(port, "starttls"))).resolves.toBe(
      "2.0.0 ready",
    );
    const ehlo = transcript.filter((entry) => entry.line.startsWith("EHLO"));
    expect(ehlo).toHaveLength(2);
    expect(ehlo.map((entry) => entry.secure)).toEqual([false, true]);
    expect(
      transcript.find((entry) => entry.line === "AUTH LOGIN")?.secure,
    ).toBe(true);
  });

  it("fails closed when STARTTLS is unavailable and never sends credentials", async () => {
    const { port, transcript } = await starttlsServer({ auth: "plain" });
    const transport = createNetworkSmtpTransport({ ca: TEST_CERT });
    await expect(transport.test(profile(port, "starttls"))).rejects.toThrow(
      /does not offer STARTTLS/,
    );
    expect(transcript.some((entry) => entry.line.startsWith("AUTH"))).toBe(
      false,
    );
  });

  it("rejects a recipient before DATA and reports the exact SMTP stage", async () => {
    const { port, transcript } = await implicitTlsServer({
      auth: "plain",
      rejectRecipient: true,
    });
    const transport = createNetworkSmtpTransport({ ca: TEST_CERT });
    await expect(
      transport.send(profile(port, "tls"), "Subject: test\r\n\r\nHello\r\n", [
        "rejected@example.com",
      ]),
    ).rejects.toThrow(/SMTP recipient rejected@example.com failed \(550\)/);
    expect(transcript.some((entry) => entry.line === "DATA")).toBe(false);
  });

  it("bounds a silent session and rejects untrusted or mismatched certificates", async () => {
    const silent = await starttlsServer({
      auth: "plain",
      silenceAfterGreeting: true,
    });
    const bounded = createNetworkSmtpTransport({
      ca: TEST_CERT,
      connectionTimeoutMs: 40,
      sessionDeadlineMs: 100,
    });
    await expect(
      bounded.test(profile(silent.port, "starttls")),
    ).rejects.toThrow(/timed out|deadline/);

    const untrusted = await implicitTlsServer({ auth: "plain" });
    await expect(
      createNetworkSmtpTransport().test(profile(untrusted.port, "tls")),
    ).rejects.toThrow(/self-signed|certificate/i);

    const mismatch = await implicitTlsServer({ auth: "plain" });
    await expect(
      createNetworkSmtpTransport({ ca: TEST_CERT }).test(
        profile(mismatch.port, "tls", "127.0.0.1"),
      ),
    ).rejects.toThrow(/IP|certificate|subject/i);

    const oversized = await implicitTlsServer({
      auth: "plain",
      oversizedEhlo: true,
    });
    await expect(
      createNetworkSmtpTransport({ ca: TEST_CERT }).test(
        profile(oversized.port, "tls"),
      ),
    ).rejects.toThrow(/response line is too large/);
  });

  it("marks a disconnect after DATA as unknown rather than safely retryable", async () => {
    const { port } = await implicitTlsServer({
      auth: "plain",
      disconnectAfterData: true,
    });
    await expect(
      createNetworkSmtpTransport({ ca: TEST_CERT }).send(
        profile(port, "tls"),
        "Subject: test\r\n\r\nHello\r\n",
        ["customer@example.com"],
      ),
    ).rejects.toThrow(/acceptance is unknown after DATA/);
  });

  it("rejects a corrupted plain-text profile before opening a socket", async () => {
    const invalid = {
      ...profile(1, "tls"),
      security: "plain",
    } as unknown as SmtpTransportProfile;
    await expect(createNetworkSmtpTransport().test(invalid)).rejects.toThrow(
      /requires implicit TLS or STARTTLS/,
    );
  });
});
