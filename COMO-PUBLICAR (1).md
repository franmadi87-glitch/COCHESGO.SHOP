# Publicar COCHES.GO en internet (60 segundos)

Esta carpeta contiene tu sitio listo para desplegar: solo un archivo `index.html` autocontenido.

## Opción más rápida: Vercel (arrastrar y soltar)

1. Ve a https://vercel.com y crea una cuenta gratis (con GitHub, Google o email).
2. Una vez dentro del panel, busca la opción de desplegar un proyecto y elige "Deploy without Git" / arrastrar carpeta (drag & drop). Si no la ves directamente, entra en https://vercel.com/new y busca la zona para soltar archivos.
3. Arrastra esta carpeta completa (`coches-go-deploy`) a esa zona.
4. Vercel te dará un link público al momento, del tipo `https://coches-go-xxxx.vercel.app`. Ese es tu sitio en vivo.

## Conectar tu dominio propio

Cuando ya tengas comprado tu dominio (ver los pasos que te di antes):

1. Dentro del proyecto en Vercel, ve a **Settings → Domains**.
2. Escribe tu dominio (ej. `cochesgo.com`) y pulsa añadir.
3. Vercel te dará 1-2 registros DNS (tipo A o CNAME) para copiar.
4. Entra en el panel de tu registrador de dominio (Namecheap, OVH, Nominalia...), busca la gestión de DNS, y pega esos registros.
5. Espera entre 10 minutos y unas horas a que se propague. Tu dominio apuntará directo al sitio.

## Importante: qué funciona y qué no todavía

- El sitio funciona de verdad, con diseño completo, formulario de publicación, filtros, favoritos, mensajes y el control de 3 anuncios gratis.
- **Los datos son locales a cada navegador**: si tú publicas un coche desde tu ordenador, alguien que entre desde su móvil no lo verá todavía. Esto es así hasta que conectemos la base de datos real (Supabase), que es el siguiente paso que ya está en marcha.
- No borres ni cierres sesión de tu navegador si quieres conservar tus anuncios de prueba mientras tanto — al conectar Supabase, migraremos todo a almacenamiento compartido de verdad.
