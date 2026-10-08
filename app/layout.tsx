import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "../providers";

/* Self-hosted (app/fonts, OFL-1.1, licenses alongside): next/font/google
   fetched these from Google on every build, and a flaky answer failed CI
   three times on 2026-10-06. Variable files, Latin only, as before. Geist
   Mono, Sora, Playfair Display and Fraunces were loaded on every route and
   used nowhere, so they are gone. */
const geistSans = localFont({ src: "./fonts/geist-sans-variable.woff2", variable: "--font-geist-sans", weight: "100 900" });
const inter = localFont({ src: "./fonts/inter-latin-wght-normal.woff2", variable: "--font-inter", weight: "100 900" });
const jetbrainsMono = localFont({ src: "./fonts/jetbrains-mono-latin-wght-normal.woff2", variable: "--font-jetbrains-mono", weight: "100 800" });
const instrumentSerif = localFont({
  src: [
    { path: "./fonts/instrument-serif-latin-400-normal.woff2", style: "normal" },
    { path: "./fonts/instrument-serif-latin-400-italic.woff2", style: "italic" },
  ],
  variable: "--font-instrument-serif",
  weight: "400",
});
const outfit = localFont({ src: "./fonts/outfit-latin-wght-normal.woff2", variable: "--font-outfit", weight: "100 900" });
const cormorantGaramond = localFont({
  src: [
    { path: "./fonts/cormorant-garamond-latin-wght-normal.woff2", style: "normal" },
    { path: "./fonts/cormorant-garamond-latin-wght-italic.woff2", style: "italic" },
  ],
  variable: "--font-cormorant",
  weight: "300 700",
});
const dmSans = localFont({ src: "./fonts/dm-sans-latin-wght-normal.woff2", variable: "--font-dm-sans", weight: "100 1000" });

export const metadata: Metadata = {
  title: {
    default: "Enki Art",
    template: "%s | Enki Art",
  },
  description:
    "Enki Art — discover, create, and generate stunning AI art with customizable prompt templates. A creative marketplace powered by Gemini AI.",
  keywords: ["AI art", "image generation", "prompt templates", "Gemini AI", "creative marketplace"],
  authors: [{ name: "Enki Art Team" }],
  // Falls back to the production origin (not localhost) so link previews
  // resolve to a fetchable absolute image URL even when the env is unset.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://enki.gallery"),
  openGraph: {
    title: "Enki Art",
    description: "The home base for AI art, turning prompts into IP.",
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Enki Art",
    images: [
      {
        url: "/og-image.jpg",
        width: 1200,
        height: 630,
        alt: "Enki Art — the home base for AI art, turning prompts into IP.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Enki Art",
    description: "The home base for AI art, turning prompts into IP.",
    images: ["/og-image.jpg"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

// Force dynamic rendering to prevent static generation issues with client components
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
              // Theme initialization
              try{var t=localStorage.getItem('theme')||'dark';var d=document.documentElement;d.classList.toggle('dark',t==='dark'||t==='purple');d.classList.toggle('theme-purple',t==='purple');}catch(e){}
              
              // Clear old Privy wallet state to prevent "Wallet with id privy not found" errors
              try{
                var keysToRemove=[];
                for(var i=0;i<localStorage.length;i++){
                  var key=localStorage.key(i);
                  if(key&&(key.includes('thirdweb')||key.includes('wallet')||key.includes('privy')||key.includes('activeWallet')||key.includes('connectedWallet'))){
                    try{
                      var value=localStorage.getItem(key);
                      if(value&&(value.includes('privy')||value.includes('"id":"privy"'))){
                        keysToRemove.push(key);
                      }
                    }catch(e){keysToRemove.push(key);}
                  }
                }
                keysToRemove.forEach(function(k){try{localStorage.removeItem(k);}catch(e){}});
                if(keysToRemove.length>0){console.log('🧹 Cleared '+keysToRemove.length+' old Privy wallet state entries');}
              }catch(e){}
              
              // Suppress Ambire wallet extension errors (non-critical)
              if(typeof window!=='undefined'){
                const originalError=console.error;
                console.error=function(...args){
                  const msg=args.join(' ');
                  if(msg.includes('resource.clone is not a function')||
                     msg.includes('ambire-inpage.js')||
                     msg.includes('Unexpected end of input')||
                     msg.includes('Wallet with id privy not found')||
                     msg.includes('Error auto connecting wallet')){
                    // Suppress non-critical errors - they don't affect functionality
                    return;
                  }
                  originalError.apply(console,args);
                };
              }
            })();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${inter.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable} ${outfit.variable} ${cormorantGaramond.variable} ${dmSans.variable} antialiased`}
      >
        <Providers>
          {/* The old top-header Navbar is retired (Kev, 2026-07-12): the app
              uses ONLY the left-side-menu shell (/home) for navigation. */}
          {children}
        </Providers>
      </body>
    </html>
  );
}
