// =============================================================================
// CONFIGURACIÓN Y CONSTANTES (DRY - Evita valores mágicos)
// =============================================================================
const CONFIG = {
    MAX_FILES: 5,
    MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
    ALLOWED_TYPE: 'application/pdf',
    DEFAULT_QUALITY: 0.5, // Calidad por defecto (50%)
    COLORS: {
        primary: '#4caf50',
        danger: '#f44336',
        warning: '#ff9800',
        success: '#4caf50'
    }
};

// =============================================================================
// CLASE: VALIDADOR DE ARCHIVOS (Single Responsibility - Solo valida)
// =============================================================================
class FileValidator {
    /**
     * Valida si el archivo es un PDF
     * @param {File} file - Archivo a validar
     * @returns {boolean}
     */
    static isPDF(file) {
        return file.type === CONFIG.ALLOWED_TYPE;
    }

    /**
     * Valida el tamaño del archivo
     * @param {File} file - Archivo a validar
     * @returns {boolean}
     */
    static isValidSize(file) {
        return file.size <= CONFIG.MAX_FILE_SIZE;
    }

    /**
     * Realiza todas las validaciones de un archivo
     * @param {File} file - Archivo a validar
     * @returns {Object} - {isValid: boolean, errors: string[]}
     */
    static validate(file) {
        const errors = [];

        if (!this.isPDF(file)) {
            errors.push(`${file.name}: Solo se permiten archivos PDF`);
        }

        if (!this.isValidSize(file)) {
            errors.push(`${file.name}: El archivo excede el tamaño máximo permitido (50MB)`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Valida múltiples archivos
     * @param {File[]} files - Array de archivos
     * @param {number} currentCount - Cantidad actual de archivos
     * @returns {Object} - {validFiles: File[], errors: string[]}
     */
    static validateMultiple(files, currentCount = 0) {
        const errors = [];
        const validFiles = [];

        // Validar cantidad total
        if (currentCount + files.length > CONFIG.MAX_FILES) {
            errors.push(`Solo puedes agregar hasta ${CONFIG.MAX_FILES} archivos en total`);
            return { validFiles: [], errors };
        }

        // Validar cada archivo individualmente
        files.forEach(file => {
            const validation = this.validate(file);
            if (validation.isValid) {
                validFiles.push(file);
            } else {
                errors.push(...validation.errors);
            }
        });

        return { validFiles, errors };
    }
}

// =============================================================================
// CLASE: FORMATEADOR DE DATOS (Single Responsibility - Solo formatea)
// =============================================================================
class DataFormatter {
    /**
     * Convierte bytes a formato legible (KB, MB, GB)
     * @param {number} bytes - Tamaño en bytes
     * @param {number} decimals - Decimales a mostrar
     * @returns {string}
     */
    static formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    }

    /**
     * Calcula el porcentaje de reducción entre dos tamaños
     * @param {number} originalSize - Tamaño original
     * @param {number} compressedSize - Tamaño comprimido
     * @returns {number}
     */
    static calculateReduction(originalSize, compressedSize) {
        if (originalSize === 0) return 0;
        const reduction = ((originalSize - compressedSize) / originalSize) * 100;
        return Math.max(0, Math.round(reduction));
    }
}

// =============================================================================
// CLASE: COMPRESOR DE PDF (Solo comprime)
// =============================================================================
class PDFCompressor {
   /**
     * Comprime un archivo PDF de forma inteligente
     * - Páginas con texto: mantiene el texto seleccionable
     * - Páginas con imágenes/escaneos: comprime las imágenes
     * @param {File} file - Archivo PDF a comprimir
     * @param {number} quality - Calidad de compresión (0.1 a 1.0)
     * @returns {Promise<File>}
     */
    static async compress(file, quality = 0.5) {
        try {
            // Leer el archivo como ArrayBuffer
            const arrayBuffer = await this._readFileAsArrayBuffer(file);

            // Crear copias independientes del ArrayBuffer
            const arrayBufferForPdfJs = arrayBuffer.slice(0);
            const arrayBufferForPdfLib = arrayBuffer.slice(0);

            // Configurar PDF.js
            pdfjsLib.GlobalWorkerOptions.workerSrc = 
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

            // Cargar el PDF con PDF.js (usando su propia copia)
            const loadingTask = pdfjsLib.getDocument({ data: arrayBufferForPdfJs });
            const pdfDocument = await loadingTask.promise;

            // Cargar también con pdf-lib (usando su propia copia)
            const sourcePdfDoc = await PDFLib.PDFDocument.load(arrayBufferForPdfLib);

            // Crear nuevo documento
            const newPdfDoc = await PDFLib.PDFDocument.create();

            // Procesar cada página
            const numPages = pdfDocument.numPages;

            for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                const page = await pdfDocument.getPage(pageNum);
                
                // Detectar si la página tiene texto seleccionable
                const hasText = await this._pageHasText(page);

                if (hasText) {
                    // Página con texto: copiar directamente (mantiene texto seleccionable)
                    console.log(`Página ${pageNum}: Tiene texto - copiando sin comprimir`);
                    const [copiedPage] = await newPdfDoc.copyPages(sourcePdfDoc, [pageNum - 1]);
                    newPdfDoc.addPage(copiedPage);
                } else {
                    // Página sin texto (imagen/escaneo): comprimir
                    console.log(`Página ${pageNum}: Solo imagen - comprimiendo`);
                    await this._compressPageAsImage(page, newPdfDoc, quality);
                }
            }

            // Limpiar recursos de PDF.js
            await pdfDocument.cleanup();
            await pdfDocument.destroy();

            // Guardar el PDF optimizado
            const compressedPdfBytes = await newPdfDoc.save({
                useObjectStreams: true,
                addDefaultPage: false
            });

            // Crear archivo comprimido
            const blob = new Blob([compressedPdfBytes], { type: 'application/pdf' });
            const compressedFile = new File(
                [blob],
                file.name.replace('.pdf', '_compressed.pdf'),
                { type: 'application/pdf' }
            );

            return compressedFile;

        } catch (error) {
            throw new Error(`Error al comprimir ${file.name}: ${error.message}`);
        }
    }

    /**
     * Detecta si una página tiene contenido de texto seleccionable
     * @param {PDFPageProxy} page - Página de PDF.js
     * @returns {Promise<boolean>}
     * @private
     */
    static async _pageHasText(page) {
        try {
            const textContent = await page.getTextContent();
            
            // Verificar si hay elementos de texto con contenido significativo
            const hasSignificantText = textContent.items.some(item => {
                const text = item.str.trim();
                // Considerar texto significativo si tiene más de 3 caracteres
                return text.length > 3;
            });

            // Considerar que tiene texto si hay al menos 5 palabras
            const wordCount = textContent.items.filter(item => 
                item.str.trim().length > 0
            ).length;

            return hasSignificantText && wordCount >= 5;

        } catch (error) {
            console.warn('Error al detectar texto en página:', error);
            // Si hay error, asumir que tiene texto para no dañarlo
            return true;
        }
    }

    /**
     * Comprime una página renderizándola como imagen
     * @param {PDFPageProxy} page - Página de PDF.js
     * @param {PDFDocument} pdfDoc - Documento pdf-lib destino
     * @param {number} quality - Calidad de compresión
     * @returns {Promise<void>}
     * @private
     */
    static async _compressPageAsImage(page, pdfDoc, quality) {
        const viewport = page.getViewport({ scale: 1.0 });

        // Crear canvas
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        
        // Ajustar escala según quality
        const scale = 0.5 + (quality * 1.5); // Entre 0.5x y 2x
        canvas.width = viewport.width * scale;
        canvas.height = viewport.height * scale;

        // Renderizar página
        await page.render({
            canvasContext: context,
            viewport: page.getViewport({ scale: scale })
        }).promise;

        // Convertir a imagen JPEG con calidad ajustable
        const imageQuality = Math.max(0.3, quality);
        const imageDataUrl = canvas.toDataURL('image/jpeg', imageQuality);
        
        // Convertir a bytes
        const imageBytes = await this._dataUrlToBytes(imageDataUrl);

        // Incrustar imagen en el PDF
        const pdfImage = await pdfDoc.embedJpg(imageBytes);
        
        // Crear página
        const newPage = pdfDoc.addPage([viewport.width, viewport.height]);
        
        // Dibujar imagen
        newPage.drawImage(pdfImage, {
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height
        });
    }

    /**
     * Comprime múltiples archivos en lote
     * @param {File[]} files - Array de archivos PDF
     * @param {number} quality - Calidad de compresión
     * @param {Function} onProgress - Callback de progreso
     * @returns {Promise<Object[]>}
     */
    static async compressBatch(files, quality, onProgress) {
        const results = [];

        for (let i = 0; i < files.length; i++) {
            try {
                const compressed = await this.compress(files[i], quality);
                results.push({
                    original: files[i],
                    compressed,
                    success: true
                });

                if (onProgress) {
                    onProgress(i + 1, files.length);
                }
            } catch (error) {
                results.push({
                    original: files[i],
                    error: error.message,
                    success: false
                });

                if (onProgress) {
                    onProgress(i + 1, files.length);
                }
            }
        }

        return results;
    }

    /**
     * Lee un archivo como ArrayBuffer
     * @param {File} file - Archivo a leer
     * @returns {Promise<ArrayBuffer>}
     * @private
     */
    static _readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error(`Error al leer ${file.name}`));
            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Convierte DataURL a Uint8Array
     * @param {string} dataUrl - DataURL de la imagen
     * @returns {Promise<Uint8Array>}
     * @private
     */
    static async _dataUrlToBytes(dataUrl) {
        const base64 = dataUrl.split(',')[1];
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        return bytes;
    }
}

// =============================================================================
// CLASE: GESTOR DE ARCHIVOS (Single Responsibility - Gestiona descargas)
// =============================================================================
class FileManager {
    /**
     * Descarga un archivo
     * @param {File} file - Archivo a descargar
     */
    static download(file) {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Descarga múltiples archivos
     * @param {File[]} files - Array de archivos
     */
    static downloadAll(files) {
        files.forEach((file, index) => {
            // Pequeño delay entre descargas para evitar bloqueo del navegador
            setTimeout(() => {
                this.download(file);
            }, index * 200);
        });
    }
}

// =============================================================================
// CLASE: GESTOR DE INTERFAZ (Single Responsibility - Maneja la UI)
// =============================================================================
class UIManager {
    /**
     * Muestra mensajes de error
     * @param {string[]} errors - Array de mensajes de error
     */
    static showErrors(errors) {
        const container = document.getElementById('errorContainer');
        
        if (errors.length === 0) {
            container.innerHTML = '';
            return;
        }

        const errorHTML = `
            <div class="alert alert-danger" role="alert">
                <i class="fas fa-exclamation-circle"></i>
                <strong>Se encontraron errores:</strong>
                <ul class="mb-0 mt-2">
                    ${errors.map(error => `<li>${error}</li>`).join('')}
                </ul>
            </div>
        `;

        container.innerHTML = errorHTML;
    }

    /**
     * Limpia los mensajes de error
     */
    static clearErrors() {
        document.getElementById('errorContainer').innerHTML = '';
    }

    /**
     * Muestra el progreso de compresión
     * @param {number} current - Archivo actual
     * @param {number} total - Total de archivos
     */
    static updateProgress(current, total) {
        const progressText = document.getElementById('progressText');
        const progressBar = document.getElementById('progressBar');
        const percentage = (current / total) * 100;

        progressText.textContent = `Comprimiendo... ${current} de ${total}`;
        progressBar.style.width = `${percentage}%`;
    }

    /**
     * Muestra el contenedor de progreso
     */
    static showProgress() {
        document.getElementById('progressContainer').style.display = 'block';
        document.getElementById('successMessage').style.display = 'none';
    }

    /**
     * Oculta el contenedor de progreso
     */
    static hideProgress() {
        document.getElementById('progressContainer').style.display = 'none';
    }

    /**
     * Muestra mensaje de éxito
     */
    static showSuccess() {
        document.getElementById('successMessage').style.display = 'block';
    }

    /**
     * Oculta mensaje de éxito
     */
    static hideSuccess() {
        document.getElementById('successMessage').style.display = 'none';
    }

    /**
     * Actualiza el valor de calidad mostrado
     * @param {number} value - Valor de calidad (10-90)
     */
    static updateQualityDisplay(value) {
        document.getElementById('qualityValue').textContent = `${value}%`;
    }
}

// =============================================================================
// CLASE: APLICACIÓN PRINCIPAL (Orchestrator - Coordina todo)
// =============================================================================
class PDFCompressorApp {
    constructor() {
        // Estado de la aplicación
        this.files = [];
        this.compressedFiles = [];
        this.isCompressing = false;
        this.compressionQuality = CONFIG.DEFAULT_QUALITY;

        // Inicializar elementos del DOM
        this.initElements();

        // Configurar eventos
        this.setupEvents();
    }

    /**
     * Inicializa las referencias a elementos del DOM
     */
    initElements() {
        this.dropZone = document.getElementById('dropZone');
        this.fileInput = document.getElementById('fileInput');
        this.fileListContainer = document.getElementById('fileListContainer');
        this.fileList = document.getElementById('fileList');
        this.fileCount = document.getElementById('fileCount');
        this.compressBtn = document.getElementById('compressBtn');
        this.downloadAllBtn = document.getElementById('downloadAllBtn');
        this.clearBtn = document.getElementById('clearBtn');
        this.addMoreBtn = document.getElementById('addMoreBtn');
        this.compressionSlider = document.getElementById('compressionQuality');
    }

    /**
     * Configura todos los eventos de la aplicación
     */
    setupEvents() {
        // Eventos de carga de archivos
        this.dropZone.addEventListener('click', () => this.fileInput.click());
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // Eventos de drag & drop
        this.dropZone.addEventListener('dragover', (e) => this.handleDragOver(e));
        this.dropZone.addEventListener('dragleave', () => this.handleDragLeave());
        this.dropZone.addEventListener('drop', (e) => this.handleDrop(e));

        // Eventos de botones
        this.compressBtn.addEventListener('click', () => this.compressFiles());
        this.downloadAllBtn.addEventListener('click', () => this.downloadAll());
        this.clearBtn.addEventListener('click', () => this.reset());
        this.addMoreBtn.addEventListener('click', () => this.fileInput.click());

        // Evento de slider de calidad
        this.compressionSlider.addEventListener('input', (e) => this.handleQualityChange(e));
    }

    /**
     * Maneja el cambio de calidad de compresión
     */
    handleQualityChange(e) {
        const value = parseInt(e.target.value);
        // Invertir el valor: slider bajo = mayor compresión = menor calidad
        this.compressionQuality = (100 - value) / 100;
        UIManager.updateQualityDisplay(value);
    }

    /**
     * Maneja la selección de archivos desde el input
     */
    handleFileSelect(e) {
        const selectedFiles = Array.from(e.target.files);
        this.addFiles(selectedFiles);
        e.target.value = ''; // Resetear input
    }

    /**
     * Maneja el evento de arrastrar sobre la zona
     */
    handleDragOver(e) {
        e.preventDefault();
        this.dropZone.classList.add('drag-over');
    }

    /**
     * Maneja cuando se sale de la zona de arrastre
     */
    handleDragLeave() {
        this.dropZone.classList.remove('drag-over');
    }

    /**
     * Maneja el evento de soltar archivos
     */
    handleDrop(e) {
        e.preventDefault();
        this.dropZone.classList.remove('drag-over');
        
        const droppedFiles = Array.from(e.dataTransfer.files);
        this.addFiles(droppedFiles);
    }

    /**
     * Agrega archivos a la lista
     */
    addFiles(newFiles) {
        // Validar archivos
        const validation = FileValidator.validateMultiple(newFiles, this.files.length);

        if (validation.validFiles.length > 0) {
            this.files.push(...validation.validFiles);
            
            // Limpiar archivos comprimidos previos para poder comprimir de nuevo
            this.compressedFiles = [];
            
            this.renderFileList();
            UIManager.clearErrors();
            UIManager.hideSuccess();
            
            // Actualizar estado de botones
            this.updateButtonStates();
        }

        if (validation.errors.length > 0) {
            UIManager.showErrors(validation.errors);
        }
    }

    /**
     * Renderiza la lista de archivos en el DOM
     */
    renderFileList() {
        // Mostrar/ocultar contenedores
        if (this.files.length > 0) {
            this.dropZone.style.display = 'none';
            this.fileListContainer.style.display = 'block';
        } else {
            this.dropZone.style.display = 'block';
            this.fileListContainer.style.display = 'none';
        }

        // Actualizar contador
        this.fileCount.textContent = this.files.length;

        // Mostrar/ocultar botón de agregar más
        this.addMoreBtn.style.display = this.files.length < CONFIG.MAX_FILES ? 'inline-block' : 'none';

        // Renderizar cada archivo
        this.fileList.innerHTML = this.files.map((file, index) => {
            const compressed = this.compressedFiles[index];
            const reduction = compressed ? 
                DataFormatter.calculateReduction(file.size, compressed.size) : 0;

            return `
                <div class="file-card">
                    <div class="file-info">
                        <div class="file-name">
                            <i class="fas fa-file-pdf"></i>
                            <span>${file.name}</span>
                        </div>
                        <div class="file-details">
                            Tamaño: ${DataFormatter.formatBytes(file.size)}
                            ${compressed ? `
                                → <span style="color: ${CONFIG.COLORS.success}; font-weight: 500;">
                                    ${DataFormatter.formatBytes(compressed.size)}
                                </span>
                                <span class="reduction-badge">-${reduction}%</span>
                            ` : ''}
                        </div>
                    </div>
                    <div class="file-actions">
                        ${compressed ? `
                            <button class="btn btn-success btn-sm" onclick="app.downloadFile(${index})">
                                <i class="fas fa-download"></i> Descargar
                            </button>
                        ` : ''}
                        <button class="btn btn-danger btn-sm" onclick="app.removeFile(${index})" 
                                ${this.isCompressing ? 'disabled' : ''}>
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Elimina un archivo de la lista
     */
    removeFile(index) {
        if (this.isCompressing) return;

        this.files.splice(index, 1);
        this.compressedFiles.splice(index, 1);
        this.renderFileList();
        UIManager.clearErrors();
        UIManager.hideSuccess();
    }

    /**
     * Comprime todos los archivos
     */
    async compressFiles() {
        if (this.files.length === 0 || this.isCompressing) return;

        this.isCompressing = true;
        this.compressedFiles = [];
        
        // Actualizar UI
        UIManager.clearErrors();
        UIManager.hideSuccess();
        UIManager.showProgress();
        this.updateButtonStates();

        try {
            // Comprimir archivos
            const results = await PDFCompressor.compressBatch(
                this.files,
                this.compressionQuality,
                (current, total) => UIManager.updateProgress(current, total)
            );

            // Separar resultados exitosos de errores
            const compressed = results.filter(r => r.success).map(r => r.compressed);
            const errors = results.filter(r => !r.success).map(r => r.error);

            this.compressedFiles = compressed;

            // Mostrar resultados
            if (errors.length > 0) {
                UIManager.showErrors(errors);
            } else {
                UIManager.showSuccess();
            }

            this.renderFileList();

        } catch (error) {
            UIManager.showErrors([`Error general: ${error.message}`]);
        } finally {
            this.isCompressing = false;
            UIManager.hideProgress();
            this.updateButtonStates();
        }
    }

    /**
     * Descarga un archivo específico
     */
    downloadFile(index) {
        if (this.compressedFiles[index]) {
            FileManager.download(this.compressedFiles[index]);
        }
    }

    /**
     * Descarga todos los archivos comprimidos
     */
    downloadAll() {
        if (this.compressedFiles.length > 0) {
            FileManager.downloadAll(this.compressedFiles);
        }
    }

    /**
     * Reinicia la aplicación
     */
    reset() {
        if (this.isCompressing) return;

        this.files = [];
        this.compressedFiles = [];
        this.renderFileList();
        UIManager.clearErrors();
        UIManager.hideSuccess();
        this.updateButtonStates();
    }

    /**
     * Actualiza el estado de los botones
     */
    updateButtonStates() {
        // Botón de comprimir
        this.compressBtn.disabled = this.isCompressing || this.compressedFiles.length > 0;

        // Botón de descargar todos
        this.downloadAllBtn.style.display = 
            this.compressedFiles.length > 0 && !this.isCompressing ? 'block' : 'none';

        // Botón de limpiar
        this.clearBtn.disabled = this.isCompressing;
    }
}

// =============================================================================
// INICIALIZACIÓN DE LA APLICACIÓN
// =============================================================================
let app;

// Esperar a que el DOM esté completamente cargado
document.addEventListener('DOMContentLoaded', () => {
    app = new PDFCompressorApp();
});