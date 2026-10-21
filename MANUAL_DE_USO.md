# Manual de uso — Linaje Qlik

## 1. ¿Qué es Linaje?

Linaje visualiza las dependencias entre aplicaciones, scripts y recursos de datos de Qlik. Permite explorar el flujo, buscar nodos, revisar sus productores y consumidores, rastrear campos y exportar el proyecto o una selección.

## 2. Iniciar la aplicación

### Versión web publicada en Vercel

Abre la URL de despliegue que te compartieron. No necesitas instalar ni ejecutar Python. La carga y el análisis de archivos se realizan en el navegador.

### Versión local incluida en `Linaje_Qlik.zip`

1. Descomprime `Linaje_Qlik.zip` en una carpeta.
2. Comprueba que tienes Python 3 instalado.
3. Abre una terminal en la carpeta descomprimida y ejecuta:

   ```text
   python linaje.py
   ```

   En algunos equipos el comando es `py linaje.py`.
4. Se abrirá la aplicación en el navegador. Si no se abre automáticamente, copia en el navegador la dirección local que muestra la terminal.
5. Para detener el servidor, vuelve a la terminal y pulsa **Ctrl+C**.

El lanzador permite conexiones desde la red local. Comparte la dirección de red solo con personas de confianza y detén el servidor cuando termines.

## 3. Cargar datos

Puedes cargar archivos con los botones de la parte superior o arrastrarlos a la ventana:

- **Carpeta Qlik**: procesa los scripts encontrados en la carpeta y sus subcarpetas.
- **ZIP / CSV**: acepta ZIP, CSV de modelo Qlik, archivos `.qvf`, `.qvs`, `.txt` y JSON de `loadscript`.
- También puedes cargar varios archivos juntos.
- **Demo**: carga un ecosistema de ejemplo para probar la interfaz.

Al terminar la carga, el diagrama muestra los nodos y las dependencias detectadas. Si importas muchos datos de apps, usa la lista **Mostrar apps** para elegir cuáles explorar. Los botones **Todas** y **Ninguna** cambian esa selección.

## 4. Explorar y buscar nodos

- En la pestaña **Explorador**, activa o desactiva los tipos de nodos: Apps, STG, DATA y Fuentes externas.
- **Ocultar recursos sin conexiones** quita del diagrama los recursos huérfanos.
- Usa el buscador situado sobre el diagrama para encontrar un nodo por nombre. Elige una coincidencia o pulsa **Enter** para centrar y seleccionar el primer resultado. La búsqueda muestra nodos visibles según los filtros activos.
- El buscador de la barra lateral filtra el contenido del grafo por nombre; no es lo mismo que el buscador sobre el diagrama, que permite saltar a un nodo.
- Arrastra el fondo para desplazar el diagrama y usa la rueda del ratón para acercar o alejar. **Centrar** vuelve a encuadrar los nodos.
- Haz clic en un nodo para ver su información, productores, consumidores, campos y, cuando esté disponible, el script.
- En el panel de información, haz clic en un productor o consumidor para ir a ese nodo.

## 5. Seleccionar y exportar nodos

1. Haz clic en un nodo para empezar una selección nueva.
2. Mantén pulsado **Ctrl** (Windows/Linux) o **Cmd** (macOS) y haz clic en otros nodos para agregarlos. Repite la combinación sobre un nodo seleccionado para quitarlo.
3. Pulsa **📤 Exportar selección JSON**.
4. Se descargará un archivo `*_seleccion_nodos.json` con los datos de los nodos elegidos y los enlaces que existen entre ellos.

La selección se limita a nodos visibles en el diagrama en el momento de exportar. Si no hay nodos seleccionados o visibles, la aplicación mostrará un aviso.

## 6. Campos y opciones visuales

- En la pestaña **Campos**, busca un campo y selecciónalo para resaltar los nodos y enlaces donde aparece. Usa **Limpiar** para quitar el resaltado.
- En **Física**, puedes cambiar la disposición, la distancia y la repulsión de los nodos, y activar o desactivar curvas, partículas animadas y etiquetas.
- **Flujo Izq → Der** alterna entre el flujo jerárquico y la disposición libre.

## 7. Matriz e informes

Pulsa **Matriz** para consultar las dependencias en forma de tabla. El selector permite exportar las apps seleccionadas con su linaje o todo el proyecto. Están disponibles los formatos **CSV**, **Excel**, **JSON** y **PPT**.

**Imagen PNG** descarga una captura del diagrama visible.

## 8. Guardar y abrir proyectos

- **Guardar Proyecto** descarga el proyecto completo en un archivo `.linaje`.
- **Abrir Proyecto** permite cargar un proyecto guardado previamente.
- El botón de exportación JSON del inspector descarga el script completo de una app cuando ese script está disponible.

## 9. Consejos y solución de problemas

- Si el diagrama aparece vacío, comprueba que el archivo tenga un formato admitido y que los filtros de tipo y apps no estén ocultando los nodos.
- Si buscas un nodo y no aparece, revisa los filtros y la selección de apps: la búsqueda del diagrama solo consulta los nodos visibles.
- Para distinguir nodos con nombres parecidos, fíjate en el tipo que aparece junto a cada resultado.
- El navegador necesita JavaScript habilitado. La aplicación incluye sus bibliotecas principales; las fuentes tipográficas externas pueden no mostrarse sin conexión a Internet.
- Mantén juntos `linaje.py` y la carpeta `linaje_app` al descomprimir el ZIP; el lanzador depende de esa estructura.
