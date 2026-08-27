import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Staredown Game — Ai chớp mắt trước sẽ thua",
  description: "Game staredown sử dụng MediaPipe để track mắt realtime. Chế độ đơn & 2 người 1 máy. Triển khai trên Vercel.",
  keywords: ["staredown", "mediapipe", "eye tracking", "game", "blink detection"],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#070a14]">{children}</body>
    </html>
  );
}
