# Linaje Qlik — versión web para Vercel

Esta carpeta es una copia autocontenida de la aplicación web. No incluye los programas de escritorio de CHECK-DATAS ni necesita Python, Node.js o un proceso de compilación para publicarse. Las bibliotecas JavaScript necesarias están en `vendor/`.

## Publicar desde GitHub

### Si usas el repositorio CHECK-DATAS

1. Sube la carpeta completa `linaje-vercel` al repositorio, incluyendo `vendor/`.
2. En Vercel, crea un proyecto nuevo e importa ese repositorio.
3. En la configuración del proyecto, define **Root Directory** como `linaje-vercel`.
4. Usa **Other** como framework. No configures un comando de build ni una carpeta de salida personalizada.
5. Pulsa **Deploy**.

### Si esta carpeta es la raíz de un repositorio separado

Importa el repositorio en Vercel y deja **Root Directory** como `.`. Usa **Other** y despliega sin comando de build.

Cada `git push` a la rama conectada generará un nuevo despliegue. También puedes importar `Linaje_Vercel.zip` a una carpeta vacía, subir esos archivos a un repositorio y conectarlo a Vercel.

## Uso

Abre la URL asignada por Vercel. Carga archivos desde los botones de la aplicación o arrástralos a la ventana. Los archivos se procesan en el navegador; no se suben a un servidor de la aplicación.

Para aprender a usar los filtros, la búsqueda, la selección múltiple y las exportaciones, consulta [MANUAL_DE_USO.md](./MANUAL_DE_USO.md).

## Archivos publicados

- `index.html`: página de entrada.
- `app.js`, `graph.js`, `parser.js`, `styles.css`: aplicación.
- `vendor/`: bibliotecas necesarias para ejecutar el diagrama y leer ZIP.
- `MANUAL_DE_USO.md`: guía de usuario.
- `vercel.json`: configuración para publicar archivos estáticos.

La aplicación utiliza fuentes de Google Fonts cuando hay conexión; sin conexión usa fuentes del sistema.
