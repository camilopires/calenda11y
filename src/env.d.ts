/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    display: import('./lib/display').DisplaySettings;
    /** Set by the admin guard after the session is verified. */
    admin?: { userId: string; email: string };
  }
}
